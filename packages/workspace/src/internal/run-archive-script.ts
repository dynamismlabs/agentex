import { ArchiveScriptFailedError } from "../errors.js";
import { runShellOneShot } from "../util/exec.js";

/**
 * Run the `scripts.archive` hook (if any) as a one-shot subprocess. Resolves
 * on exit; throws `ArchiveScriptFailedError` on non-zero exit or signal.
 *
 * The script sees `AGENTEX_WORKSPACE` and (when set) `AGENTEX_SOURCE` in its
 * environment. No streaming, no `RunHandle`, no process-group teardown — those
 * belong to slice 4's `runScript`. This hook is for tear-down commands like
 * "drop a database" / "remove a cache directory" / "deregister with a service."
 */
export async function runArchiveScriptIfPresent(args: {
  archiveScript: string | undefined;
  workspacePath: string;
  source: string | undefined;
}): Promise<void> {
  const script = args.archiveScript;
  if (!script || script.trim().length === 0) return;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTEX_WORKSPACE: args.workspacePath,
  };
  if (args.source !== undefined) env.AGENTEX_SOURCE = args.source;

  const result = await runShellOneShot(script, {
    cwd: args.workspacePath,
    env,
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new ArchiveScriptFailedError({
      script,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
    });
  }
}
