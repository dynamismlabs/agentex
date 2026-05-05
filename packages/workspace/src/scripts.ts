import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { EmptyScriptError, ScriptNotFoundError } from "./errors.js";
import { loadWorkspaceConfig } from "./config.js";
import type { PortAllocator, RunHandle } from "./types.js";

/**
 * Spawn `scripts.<name>` from `agentex.workspace.json` as a long-lived
 * subprocess and return a `RunHandle`.
 *
 * - Each invocation gets its own process group (`detached: true` → setsid on
 *   POSIX). `kill(-pid)` therefore tears down the script *and* anything it
 *   spawned, hiding the orphaned-`&`-process footgun.
 * - The script sees `AGENTEX_WORKSPACE`, `AGENTEX_SOURCE` (when provided), and
 *   `AGENTEX_PORT` (set to the first port the consumer has already allocated
 *   on `ws.ports`; absent when nothing is held).
 * - `output` is a Web `ReadableStream<Uint8Array>` that delivers stdout *and*
 *   stderr, interleaved in arrival order. The stream ends when both child
 *   pipes have closed.
 *
 * Throws `ScriptNotFoundError` when `name` is not in the config.
 * Throws `EmptyScriptError` when the entry exists but is empty/whitespace.
 */
export async function runWorkspaceScript(args: {
  workspacePath: string;
  source: string | undefined;
  ports: PortAllocator;
  name: string;
}): Promise<RunHandle> {
  const config = await loadWorkspaceConfig({
    source: args.source,
    workspacePath: args.workspacePath,
  });
  const scripts = config.scripts ?? {};

  if (!Object.prototype.hasOwnProperty.call(scripts, args.name)) {
    throw new ScriptNotFoundError(args.name, Object.keys(scripts));
  }
  const command = scripts[args.name] ?? "";
  if (command.trim().length === 0) {
    throw new EmptyScriptError(args.name);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTEX_WORKSPACE: args.workspacePath,
  };
  if (args.source !== undefined) env.AGENTEX_SOURCE = args.source;
  const heldPorts = args.ports.held();
  if (heldPorts.length > 0) env.AGENTEX_PORT = String(heldPorts[0]);

  const child = spawn(command, {
    cwd: args.workspacePath,
    env,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) {
    throw new Error(`runScript: failed to spawn script "${args.name}"`);
  }
  // Capture as a number so closures don't have to re-narrow.
  const leaderPid: number = child.pid;

  // Merge stdout + stderr into a single PassThrough; close it when both child
  // pipes end. `pipe(..., { end: false })` is required so the first pipe
  // ending doesn't end the merged stream while the other is still emitting.
  const merged = new PassThrough();
  let openPipes = 2;
  const closePipe = (): void => {
    openPipes -= 1;
    if (openPipes === 0) merged.end();
  };
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error(`runScript: stdio pipes were not created for script "${args.name}"`);
  }
  stdout.on("end", closePipe);
  stderr.on("end", closePipe);
  stdout.on("error", (err) => merged.destroy(err));
  stderr.on("error", (err) => merged.destroy(err));
  stdout.pipe(merged, { end: false });
  stderr.pipe(merged, { end: false });

  // Resolve "child has exited" once, regardless of who calls kill.
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

  let killed = false;
  async function kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (killed) {
      await exited;
      return;
    }
    killed = true;

    // If the child already exited (script ran to completion before kill was
    // called), skip the syscall — the leader's pid may have been reaped or
    // reassigned to something else we don't own.
    if (child.exitCode !== null || child.signalCode !== null) {
      await exited;
      return;
    }

    try {
      // Negative pid targets the process group leader's group, killing every
      // process spawned by the script — not just the leader.
      process.kill(-leaderPid, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH: group is gone (raced with natural exit).
      // EPERM: stale pid (group leader reaped between our check and syscall);
      //        treat the same as "already gone" rather than throw.
      if (code !== "ESRCH" && code !== "EPERM") throw err;
    }
    await exited;
  }

  const output = Readable.toWeb(merged) as ReadableStream<Uint8Array>;

  return {
    pid: leaderPid,
    output,
    kill,
  };
}
