import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import { setupSimpleRepo } from "../git-helpers.js";

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

async function makeGitWorkspace(label: string) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const wsPath = path.join(root, "ws");
  await setupSimpleRepo(sourcePath);
  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "main",
    path: wsPath,
    branch: "feature/raw",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.raw", () => {
  it("runs an arbitrary git command and returns full result on success", async () => {
    const { ws } = await makeGitWorkspace("raw-success");

    const r = await ws.git.raw(["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("feature/raw");
    expect(r.stderr).toBe("");
  });

  it("returns full result for non-zero exit (does NOT throw)", async () => {
    const { ws } = await makeGitWorkspace("raw-nonzero");

    const r = await ws.git.raw(["rev-parse", "--verify", "refs/heads/never-existed"]);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("uses the worktree as cwd (operations affect the worktree, not the source)", async () => {
    const { wsPath, ws } = await makeGitWorkspace("raw-cwd");
    await writeUtf8(path.join(wsPath, "from-raw.txt"), "raw\n");

    const add = await ws.git.raw(["add", "from-raw.txt"]);
    expect(add.exitCode).toBe(0);

    // Now status should show staged
    const status = await ws.git.status();
    expect(status.staged).toContain("from-raw.txt");
  });

  it("validates args: rejects non-array, rejects non-string entries", async () => {
    const { ws } = await makeGitWorkspace("raw-validate");

    // @ts-expect-error — intentionally wrong type
    await expect(ws.git.raw("status")).rejects.toThrow(/must be an array/);
    // @ts-expect-error — intentionally wrong type
    await expect(ws.git.raw(["status", 1])).rejects.toThrow(/each arg must be a string/);
  });

  it("supports operations the typed surface doesn't cover (e.g. `log`, `stash list`)", async () => {
    const { ws } = await makeGitWorkspace("raw-coverage-gap");

    const log = await ws.git.raw(["log", "-1", "--pretty=%s"]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout.trim().length).toBeGreaterThan(0);

    const stash = await ws.git.raw(["stash", "list"]);
    expect(stash.exitCode).toBe(0);
  });
});
