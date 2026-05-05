import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { MergeConflictError, workspace } from "../../src/index.js";
import { makeTmpDir, pathExists, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
import {
  addOrigin,
  commitFile,
  git,
  initBareRemote,
  initRepo,
  pushBranch as remotePush,
  setupSimpleRepo,
} from "../git-helpers.js";

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

/**
 * Build a 3-repo topology:
 *   - bare remote (origin)
 *   - source (where we create the worktree from)
 *   - dev clone (a "second developer" advancing main on the remote)
 */
async function makeRemoteTopology(label: string) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const remotePath = path.join(root, "remote.git");
  const devPath = path.join(root, "dev");

  await setupSimpleRepo(sourcePath);
  await initBareRemote(remotePath);
  await addOrigin(sourcePath, remotePath);
  await remotePush(sourcePath, "main");

  // Clone for the "second developer" workflow.
  await git(root, "clone", remotePath, devPath);
  await git(devPath, "config", "user.email", "dev@example.com");
  await git(devPath, "config", "user.name", "Dev");
  await git(devPath, "config", "commit.gpgsign", "false");

  return { root, sourcePath, remotePath, devPath };
}

describe("ws.git.pullLatestBase", () => {
  it("merge strategy (default) integrates upstream commits into the current branch", async () => {
    const { root, sourcePath, devPath } = await makeRemoteTopology("pull-merge");
    const wsPath = path.join(root, "ws");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/merge",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    // Advance origin/main from the dev clone.
    await commitFile(devPath, "from-dev.md", "dev wrote this\n", "dev advances main");
    await git(devPath, "push", "origin", "main");

    // Make a non-conflicting local commit on feature/merge so the merge isn't
    // a fast-forward.
    await writeUtf8(path.join(wsPath, "local.md"), "local\n");
    await ws.git.commit("local commit");

    await ws.git.pullLatestBase(); // default strategy: merge

    expect(await pathExists(path.join(wsPath, "from-dev.md"))).toBe(true);
    expect(await pathExists(path.join(wsPath, "local.md"))).toBe(true);

    // The merge commit should be the new HEAD.
    const { stdout: log } = await git(wsPath, "log", "-3", "--pretty=%s");
    expect(log).toContain("local commit");
    expect(log).toContain("dev advances main");
  });

  it("rebase strategy replays local commits on top of latest base", async () => {
    const { root, sourcePath, devPath } = await makeRemoteTopology("pull-rebase");
    const wsPath = path.join(root, "ws");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/rebase",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await commitFile(devPath, "upstream.md", "from upstream\n", "upstream advance");
    await git(devPath, "push", "origin", "main");

    await writeUtf8(path.join(wsPath, "local.md"), "local\n");
    await ws.git.commit("local commit");

    await ws.git.pullLatestBase({ strategy: "rebase" });

    // After rebase, the most recent commit should be ours, on top of the upstream.
    const { stdout: log } = await git(wsPath, "log", "--pretty=%s");
    const lines = log.trim().split("\n");
    expect(lines[0]).toBe("local commit");
    expect(lines).toContain("upstream advance");

    expect(await pathExists(path.join(wsPath, "upstream.md"))).toBe(true);
    expect(await pathExists(path.join(wsPath, "local.md"))).toBe(true);
  });

  it("merge strategy: conflict throws MergeConflictError with the unmerged file list", async () => {
    const root = await tmp("pull-conflict-merge");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    const devPath = path.join(root, "dev");

    // Source repo with a "conflict.md" file already committed.
    await initRepo(sourcePath);
    await commitFile(sourcePath, "conflict.md", "alpha\n", "initial conflict.md");
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");

    await git(root, "clone", remotePath, devPath);
    await git(devPath, "config", "user.email", "dev@example.com");
    await git(devPath, "config", "user.name", "Dev");
    await git(devPath, "config", "commit.gpgsign", "false");
    await commitFile(devPath, "conflict.md", "remote-version\n", "dev changes conflict");
    await git(devPath, "push", "origin", "main");

    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/conflict",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await writeUtf8(path.join(wsPath, "conflict.md"), "local-version\n");
    await ws.git.commit("local conflicts on conflict.md");

    let caught: unknown = null;
    try {
      await ws.git.pullLatestBase(); // merge
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MergeConflictError);
    expect((caught as MergeConflictError).files).toContain("conflict.md");

    // Conflict markers should be present in the file (left in place per PRD).
    const content = await readUtf8(path.join(wsPath, "conflict.md"));
    expect(content).toMatch(/<<<<<<</);
  });

  it("rebase strategy: conflict throws MergeConflictError too", async () => {
    const root = await tmp("pull-conflict-rebase");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    const devPath = path.join(root, "dev");

    await initRepo(sourcePath);
    await commitFile(sourcePath, "conflict.md", "alpha\n", "initial conflict.md");
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");

    await git(root, "clone", remotePath, devPath);
    await git(devPath, "config", "user.email", "dev@example.com");
    await git(devPath, "config", "user.name", "Dev");
    await git(devPath, "config", "commit.gpgsign", "false");
    await commitFile(devPath, "conflict.md", "remote-version\n", "dev changes conflict");
    await git(devPath, "push", "origin", "main");

    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/rebase-conflict",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await writeUtf8(path.join(wsPath, "conflict.md"), "local-version\n");
    await ws.git.commit("local conflicts on conflict.md");

    await expect(ws.git.pullLatestBase({ strategy: "rebase" })).rejects.toBeInstanceOf(
      MergeConflictError,
    );
  });
});
