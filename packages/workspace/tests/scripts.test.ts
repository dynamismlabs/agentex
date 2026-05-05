import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EmptyScriptError, ScriptNotFoundError, workspace } from "../src/index.js";
import {
  makeTmpDir,
  pathExists,
  removeTmpDir,
  writeUtf8,
} from "./helpers.js";
import { setupSimpleRepo } from "./git-helpers.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

async function tmp(label: string): Promise<string> {
  const dir = await makeTmpDir(label);
  tmpDirs.push(dir);
  return dir;
}

async function makeBareWithScripts(
  label: string,
  scripts: Record<string, string>,
  source?: string,
) {
  const root = await tmp(label);
  const wsPath = path.join(root, "ws");
  if (source !== undefined) {
    await fs.mkdir(source, { recursive: true });
  }
  const ws = await workspace.create({ kind: "bare", path: wsPath, source });
  await writeUtf8(
    path.join(wsPath, "agentex.workspace.json"),
    JSON.stringify({ scripts }),
  );
  return { root, wsPath, ws };
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function waitForFile(p: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(p)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for file: ${p}`);
}

async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for pid ${pid} to die`);
}

describe("runScript", () => {
  it("runs the named script and exposes pid + combined stdout/stderr stream", async () => {
    const { ws } = await makeBareWithScripts("rs-basic", {
      run: "echo hello-stdout; echo bye-stderr 1>&2",
    });

    const handle = await ws.runScript("run");

    expect(handle.pid).toBeGreaterThan(0);
    const out = await drainStream(handle.output);
    expect(out).toContain("hello-stdout");
    expect(out).toContain("bye-stderr");
    await handle.kill();
  });

  it("AGENTEX_WORKSPACE is set in the script's environment", async () => {
    const { wsPath, ws } = await makeBareWithScripts("rs-env-ws", {
      run: 'printf "%s" "$AGENTEX_WORKSPACE"',
    });

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toBe(wsPath);
    await handle.kill();
  });

  it("AGENTEX_SOURCE is set when the workspace has a source", async () => {
    const root = await tmp("rs-env-source");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });
    const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { run: 'printf "%s" "$AGENTEX_SOURCE"' } }),
    );

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toBe(sourcePath);
    await handle.kill();
  });

  it("AGENTEX_SOURCE is unset when source was not provided at create", async () => {
    const { ws } = await makeBareWithScripts("rs-env-no-source", {
      run: 'printf "[%s]" "${AGENTEX_SOURCE-unset}"',
    });

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toBe("[unset]");
    await handle.kill();
  });

  it("AGENTEX_PORT is set to the first port held on the allocator", async () => {
    const { ws } = await makeBareWithScripts("rs-env-port", {
      run: 'printf "%s" "$AGENTEX_PORT"',
    });

    const [first, ...rest] = await ws.ports.allocate(2);
    expect(rest.length).toBe(1);

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toBe(String(first));
    await handle.kill();
  });

  it("AGENTEX_PORT is unset when nothing has been allocated", async () => {
    const { ws } = await makeBareWithScripts("rs-env-noport", {
      run: 'printf "[%s]" "${AGENTEX_PORT-unset}"',
    });

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toBe("[unset]");
    await handle.kill();
  });

  it("throws ScriptNotFoundError when the script name is not in the config", async () => {
    const { ws } = await makeBareWithScripts("rs-missing", { run: "true" });

    const err = await ws.runScript("not-here").catch((e) => e);
    expect(err).toBeInstanceOf(ScriptNotFoundError);
    expect((err as ScriptNotFoundError).script).toBe("not-here");
    expect((err as ScriptNotFoundError).available).toContain("run");
  });

  it("throws EmptyScriptError when the entry exists but is empty/whitespace", async () => {
    const { ws } = await makeBareWithScripts("rs-empty", {
      run: "true",
      placeholder: "",
      blanks: "   ",
    });

    const err1 = await ws.runScript("placeholder").catch((e) => e);
    expect(err1).toBeInstanceOf(EmptyScriptError);
    expect((err1 as EmptyScriptError).script).toBe("placeholder");

    const err2 = await ws.runScript("blanks").catch((e) => e);
    expect(err2).toBeInstanceOf(EmptyScriptError);
    expect((err2 as EmptyScriptError).script).toBe("blanks");
  });

  it("supports arbitrary script names — `web`, `api`, `worker`, anything", async () => {
    const { ws } = await makeBareWithScripts("rs-arbitrary", {
      web: 'printf "web-ok"',
      api: 'printf "api-ok"',
      worker: 'printf "worker-ok"',
    });

    const [web, api, worker] = await Promise.all([
      ws.runScript("web"),
      ws.runScript("api"),
      ws.runScript("worker"),
    ]);

    const [webOut, apiOut, workerOut] = await Promise.all([
      drainStream(web.output),
      drainStream(api.output),
      drainStream(worker.output),
    ]);

    expect(webOut).toBe("web-ok");
    expect(apiOut).toBe("api-ok");
    expect(workerOut).toBe("worker-ok");

    await Promise.all([web.kill(), api.kill(), worker.kill()]);
  });

  it("kill terminates the script (regular case)", async () => {
    const { ws } = await makeBareWithScripts("rs-kill", {
      run: "sleep 30",
    });

    const handle = await ws.runScript("run");
    expect(isAlive(handle.pid)).toBe(true);

    await handle.kill();

    await waitForPidGone(handle.pid);
  });

  it("kill tears down the entire process group, not just the leader", async () => {
    const root = await tmp("rs-kill-group");
    const wsPath = path.join(root, "ws");
    const sentinelDir = path.join(root, "sentinel");
    await fs.mkdir(sentinelDir, { recursive: true });
    const childPidFile = path.join(sentinelDir, "child-pid");

    const ws = await workspace.create({ kind: "bare", path: wsPath });
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({
        scripts: {
          run: `sleep 60 & echo $! > "${childPidFile}"; wait`,
        },
      }),
    );

    const handle = await ws.runScript("run");

    // Wait for the script to spawn the child sleep and write its pid.
    await waitForFile(childPidFile);
    const childPid = parseInt((await fs.readFile(childPidFile, "utf-8")).trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(handle.pid)).toBe(true);

    await handle.kill();

    await waitForPidGone(handle.pid);
    await waitForPidGone(childPid);
  });

  it("kill is idempotent — repeated calls await the same exit", async () => {
    const { ws } = await makeBareWithScripts("rs-kill-idem", {
      run: "sleep 30",
    });

    const handle = await ws.runScript("run");
    await Promise.all([handle.kill(), handle.kill(), handle.kill()]);
    expect(isAlive(handle.pid)).toBe(false);
  });

  it("output stream ends naturally when script exits without kill", async () => {
    const { ws } = await makeBareWithScripts("rs-natural-end", {
      run: "echo done",
    });

    const handle = await ws.runScript("run");
    const out = await drainStream(handle.output);
    expect(out).toContain("done");
    // The kill below is a no-op — script already exited — but exercises the
    // already-exited branch in handle.kill.
    await handle.kill();
  });

  it("works on git workspaces too", async () => {
    const root = await tmp("rs-git");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/scripts",
    });

    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { dev: 'printf "%s" "$AGENTEX_WORKSPACE"' } }),
    );

    const handle = await ws.runScript("dev");
    const out = await drainStream(handle.output);
    expect(out).toBe(wsPath);
    await handle.kill();
  });

  it("workspace-side scripts override source-side scripts", async () => {
    const root = await tmp("rs-config-merge");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { dev: 'printf "from-source"' } }),
    );

    const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { dev: 'printf "from-workspace"' } }),
    );

    const handle = await ws.runScript("dev");
    const out = await drainStream(handle.output);
    expect(out).toBe("from-workspace");
    await handle.kill();
  });
});
