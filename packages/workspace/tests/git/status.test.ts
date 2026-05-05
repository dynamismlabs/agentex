import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import {
  addOrigin,
  commitFile,
  git,
  initBareRemote,
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
    branch: "feature/status",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.status", () => {
  it("returns clean status on a fresh worktree", async () => {
    const { ws } = await makeGitWorkspace("status-clean");
    const status = await ws.git.status();

    expect(status.dirty).toBe(false);
    expect(status.untracked).toEqual([]);
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("reports untracked files", async () => {
    const { wsPath, ws } = await makeGitWorkspace("status-untracked");
    await writeUtf8(path.join(wsPath, "new.txt"), "hi\n");
    await writeUtf8(path.join(wsPath, "another.txt"), "yo\n");

    const status = await ws.git.status();

    expect(status.dirty).toBe(true);
    expect(status.untracked.sort()).toEqual(["another.txt", "new.txt"]);
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  it("reports modified-in-worktree files", async () => {
    const { wsPath, ws } = await makeGitWorkspace("status-modified");
    await writeUtf8(path.join(wsPath, "README.md"), "# changed\n");

    const status = await ws.git.status();

    expect(status.dirty).toBe(true);
    expect(status.modified).toEqual(["README.md"]);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it("reports staged files", async () => {
    const { wsPath, ws } = await makeGitWorkspace("status-staged");
    await writeUtf8(path.join(wsPath, "new.txt"), "hi\n");
    await git(wsPath, "add", "new.txt");

    const status = await ws.git.status();

    expect(status.dirty).toBe(true);
    expect(status.staged).toEqual(["new.txt"]);
    expect(status.modified).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it("reports a file that is staged AND further modified in worktree on both lists", async () => {
    const { wsPath, ws } = await makeGitWorkspace("status-staged-then-modified");
    await writeUtf8(path.join(wsPath, "README.md"), "v1\n");
    await git(wsPath, "add", "README.md");
    await writeUtf8(path.join(wsPath, "README.md"), "v2\n");

    const status = await ws.git.status();

    expect(status.staged).toContain("README.md");
    expect(status.modified).toContain("README.md");
  });

  it("ahead/behind reflect distance from upstream", async () => {
    const root = await tmp("status-ahead-behind");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/track",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    // Set upstream via initial push.
    await ws.git.push();

    expect((await ws.git.status()).ahead).toBe(0);

    // Local commit → +1 ahead
    await writeUtf8(path.join(wsPath, "local.txt"), "local\n");
    await ws.git.commit("local commit");
    expect((await ws.git.status()).ahead).toBe(1);

    // Remote commit on the upstream of feature/track (push from a "developer"
    // clone), then fetch in the worktree. The worktree's branch should now
    // show behind=1, ahead=1.
    const dev = path.join(root, "dev-clone");
    await git(root, "clone", remotePath, dev);
    await git(dev, "config", "user.email", "test@example.com");
    await git(dev, "config", "user.name", "Dev");
    await git(dev, "config", "commit.gpgsign", "false");
    await git(dev, "fetch", "origin", "feature/track");
    await git(dev, "checkout", "-b", "feature/track", "origin/feature/track");
    await commitFile(dev, "remote.txt", "remote\n", "remote commit");
    await git(dev, "push", "origin", "feature/track");

    await git(wsPath, "fetch", "origin", "feature/track");

    const status = await ws.git.status();
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(1);
  });
});
