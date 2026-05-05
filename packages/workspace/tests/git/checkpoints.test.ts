import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
import {
  addOrigin,
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
    branch: "feature/checkpoints",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.checkpoint / restore / checkpoints / deleteCheckpoint", () => {
  it("checkpoint creates a per-worktree ref under refs/worktree/agentex/checkpoints/<label>", async () => {
    const { wsPath, ws } = await makeGitWorkspace("cp-create-list");

    expect(await ws.git.checkpoints()).toEqual([]);

    await ws.git.checkpoint("v1");
    expect(await ws.git.checkpoints()).toEqual(["v1"]);

    const { stdout } = await git(wsPath, "show-ref", "refs/worktree/agentex/checkpoints/v1");
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it("checkpoints() returns multiple labels sorted alphabetically", async () => {
    const { ws } = await makeGitWorkspace("cp-multi");
    await ws.git.checkpoint("zeta");
    await ws.git.checkpoint("alpha");
    await ws.git.checkpoint("middle");

    expect(await ws.git.checkpoints()).toEqual(["alpha", "middle", "zeta"]);
  });

  it("restore resets HEAD to the snapshot, dropping subsequent commits and uncommitted changes", async () => {
    const { wsPath, ws } = await makeGitWorkspace("cp-restore");

    await writeUtf8(path.join(wsPath, "file.txt"), "v1\n");
    await ws.git.commit("v1");

    await ws.git.checkpoint("snap");

    await writeUtf8(path.join(wsPath, "file.txt"), "v2\n");
    await ws.git.commit("v2");

    await writeUtf8(path.join(wsPath, "file.txt"), "v3-uncommitted\n");

    await ws.git.restore("snap");

    expect(await readUtf8(path.join(wsPath, "file.txt"))).toBe("v1\n");
    expect((await ws.git.status()).dirty).toBe(false);
  });

  it("restore on a non-existent label throws", async () => {
    const { ws } = await makeGitWorkspace("cp-restore-missing");
    await expect(ws.git.restore("never-checkpointed")).rejects.toThrow(/checkpoint not found/);
  });

  it("checkpoint with empty/whitespace/invalid label throws", async () => {
    const { ws } = await makeGitWorkspace("cp-bad-label");
    await expect(ws.git.checkpoint("")).rejects.toThrow(/non-empty/);
    await expect(ws.git.checkpoint("with space")).rejects.toThrow(/invalid label/);
    await expect(ws.git.checkpoint("/leading-slash")).rejects.toThrow(/invalid label/);
    await expect(ws.git.checkpoint("a..b")).rejects.toThrow(/invalid label/);
  });

  it("checkpoints survive workspace.open() round-trip", async () => {
    const { wsPath, sourcePath, ws } = await makeGitWorkspace("cp-survive-open");
    await ws.git.checkpoint("persistent");

    const reopened = await workspace.open(wsPath, { source: sourcePath });
    if (reopened.kind !== "git") throw new Error("expected git");

    expect(await reopened.git.checkpoints()).toContain("persistent");
  });

  it("checkpoints are not visible to sibling worktrees of the same source (per-worktree namespace)", async () => {
    const root = await tmp("cp-isolation");
    const sourcePath = path.join(root, "source");
    const wsAPath = path.join(root, "ws-a");
    const wsBPath = path.join(root, "ws-b");
    await setupSimpleRepo(sourcePath);

    const wsA = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsAPath,
      branch: "feature/a",
    });
    const wsB = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsBPath,
      branch: "feature/b",
    });
    if (wsA.kind !== "git" || wsB.kind !== "git") throw new Error("expected git");

    await wsA.git.checkpoint("a-only");
    await wsB.git.checkpoint("b-only");

    expect(await wsA.git.checkpoints()).toEqual(["a-only"]);
    expect(await wsB.git.checkpoints()).toEqual(["b-only"]);
  });

  it("checkpoints are not pushed by `git push` (refs/worktree/* is outside the default refspec)", async () => {
    const root = await tmp("cp-not-pushed");
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
      branch: "feature/no-push",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await writeUtf8(path.join(wsPath, "x.txt"), "v\n");
    await ws.git.commit("c");
    await ws.git.checkpoint("local-only");
    await ws.git.push();

    const remoteRefs = await git(remotePath, "for-each-ref", "--format=%(refname)");
    expect(remoteRefs.stdout).not.toContain("refs/worktree/agentex/checkpoints/local-only");
  });

  it("deleteCheckpoint removes a checkpoint; no-op if it doesn't exist", async () => {
    const { ws } = await makeGitWorkspace("cp-delete");
    await ws.git.checkpoint("doomed");
    expect(await ws.git.checkpoints()).toEqual(["doomed"]);

    await ws.git.deleteCheckpoint("doomed");
    expect(await ws.git.checkpoints()).toEqual([]);

    // Idempotent — second delete is a no-op.
    await expect(ws.git.deleteCheckpoint("doomed")).resolves.toBeUndefined();
  });

  it("checkpoints are auto-cleaned by `git worktree remove` (refs/worktree/* lifetime)", async () => {
    const root = await tmp("cp-auto-clean");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/cleanup",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await ws.git.checkpoint("temp");
    expect(await ws.git.checkpoints()).toEqual(["temp"]);

    await workspace.archive(wsPath);

    // Source-side sweep — no leftover refs/worktree/agentex/* should survive.
    const refs = await git(sourcePath, "for-each-ref", "--format=%(refname)", "refs/worktree/");
    expect(refs.stdout).not.toContain("agentex/checkpoints/temp");
  });
});
