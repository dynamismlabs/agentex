import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ArchiveScriptFailedError,
  DirtyWorktreeError,
  workspace,
} from "../../src/index.js";
import { makeTmpDir, pathExists, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
import { addOrigin, git, initBareRemote, pushBranch, setupSimpleRepo } from "../git-helpers.js";

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

describe("workspace.archive (git)", () => {
  it("with { force: true } removes the worktree and prunes the source's stale tracking", async () => {
    const root = await tmp("git-archive-force");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/x",
    });

    await workspace.archive(wsPath, { force: true });

    expect(await pathExists(wsPath)).toBe(false);

    // Source still has the branch (slice 2 doesn't delete branches), but worktree
    // tracking is pruned — `git worktree list` should not include wsPath.
    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(sourcePath, "worktree", "list");
    expect(stdout).not.toContain(wsPath);
  });

  it("without { force: true } on a CLEAN workspace removes successfully", async () => {
    const root = await tmp("git-archive-clean");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/clean-archive",
    });

    await workspace.archive(wsPath);

    expect(await pathExists(wsPath)).toBe(false);
  });

  it("without { force: true } on a DIRTY workspace throws DirtyWorktreeError; worktree preserved", async () => {
    const root = await tmp("git-archive-dirty");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/dirty-archive",
    });

    await writeUtf8(path.join(wsPath, "scratch.md"), "uncommitted\n");

    let caught: unknown = null;
    try {
      await workspace.archive(wsPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DirtyWorktreeError);
    expect((caught as DirtyWorktreeError).status.untracked).toContain("scratch.md");

    expect(await pathExists(wsPath)).toBe(true);
    expect(await pathExists(path.join(wsPath, "scratch.md"))).toBe(true);

    // Cleanup with force.
    await workspace.archive(wsPath, { force: true });
  });

  it("with { force: true } on a DIRTY workspace removes anyway", async () => {
    const root = await tmp("git-archive-force-dirty");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/force-dirty",
    });

    await writeUtf8(path.join(wsPath, "scratch.md"), "uncommitted\n");

    await workspace.archive(wsPath, { force: true });

    expect(await pathExists(wsPath)).toBe(false);
  });

  it("runs scripts.archive (one-shot) before removing; script sees AGENTEX_WORKSPACE and AGENTEX_SOURCE", async () => {
    const root = await tmp("git-archive-script");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    const sentinelDir = path.join(root, "sentinel");
    await setupSimpleRepo(sourcePath);
    await fs.mkdir(sentinelDir, { recursive: true });

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/script",
    });

    const sentinel = path.join(sentinelDir, "ran");
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({
        scripts: {
          archive: `printf '%s|%s' "$AGENTEX_WORKSPACE" "$AGENTEX_SOURCE" > "${sentinel}"`,
        },
      }),
    );

    await workspace.archive(wsPath, { force: true });

    expect(await pathExists(wsPath)).toBe(false);
    expect(await pathExists(sentinel)).toBe(true);
    const content = await readUtf8(sentinel);
    // realpath comparison handles macOS /var → /private/var symlink for the workspace path.
    const realWs = await fs.realpath(path.dirname(sentinel)); // sanity: realpath available
    expect(realWs.length).toBeGreaterThan(0);
    const [seenWs, seenSource] = content.split("|");
    expect(seenWs).toBe(wsPath);
    expect(seenSource).toBe(sourcePath);
  });

  it("throws ArchiveScriptFailedError on non-zero exit; worktree is not removed", async () => {
    const root = await tmp("git-archive-script-fail");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/script-fail",
    });

    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { archive: "exit 9" } }),
    );

    await expect(workspace.archive(wsPath, { force: true })).rejects.toBeInstanceOf(
      ArchiveScriptFailedError,
    );
    expect(await pathExists(wsPath)).toBe(true);

    // Cleanup with a non-failing config.
    await fs.unlink(path.join(wsPath, "agentex.workspace.json"));
    await workspace.archive(wsPath, { force: true });
  });

  it("missing-on-disk + opts.source runs `git worktree prune` on source", async () => {
    const root = await tmp("git-archive-missing-prune");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/del",
    });

    // Simulate user-deleted-the-directory.
    await fs.rm(wsPath, { recursive: true, force: true });

    // Stale tracking should be cleaned by archive(missingPath, { source }).
    await workspace.archive(wsPath, { source: sourcePath });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(sourcePath, "worktree", "list");
    expect(stdout).not.toContain(wsPath);
  });

  it("missing-on-disk without opts.source is a no-op", async () => {
    const root = await tmp("git-archive-missing-noop");
    const missing = path.join(root, "never-existed");

    await expect(workspace.archive(missing)).resolves.toBeUndefined();
  });

  describe("deleteBranch", () => {
    it("deleteBranch: true on a clean (merged) worktree deletes the branch ref", async () => {
      const root = await tmp("git-archive-delbranch-clean");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/del-clean",
      });

      // No new commits: the branch points at main's tip, so it's trivially
      // merged and the safe `-d` delete succeeds.
      await workspace.archive(wsPath, { deleteBranch: true });

      expect(await pathExists(wsPath)).toBe(false);
      expect(await branchRefExists(sourcePath, "feature/del-clean")).toBe(false);
    });

    it("deleteBranch: true (no force) deletes a PUSHED branch that isn't merged into local main", async () => {
      // This is the real-world consumer path: a feature branch with commits
      // that were pushed to a remote (so it has an upstream and status.ahead is
      // 0) but never merged into the source's local main. The safe `git branch
      // -d` must still succeed here — git treats "fully contained in upstream"
      // as merged — otherwise every archive of a pushed-but-unmerged session
      // would spuriously require force.
      const root = await tmp("git-archive-delbranch-pushed");
      const sourcePath = path.join(root, "source");
      const remotePath = path.join(root, "remote.git");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);
      await initBareRemote(remotePath);
      await addOrigin(sourcePath, remotePath);
      await pushBranch(sourcePath, "main");

      const ws = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/pushed",
      });
      if (ws.kind !== "git") throw new Error("expected git workspace");

      await writeUtf8(path.join(wsPath, "feature.ts"), "export const x = 1;\n");
      await ws.git.commit("add feature");
      await ws.git.push();

      // Sanity: committed (not dirty) and fully pushed (ahead 0), but NOT on
      // local main.
      const status = await ws.git.status();
      expect(status.dirty).toBe(false);
      expect(status.ahead).toBe(0);
      expect(await branchRefExists(sourcePath, "feature/pushed")).toBe(true);

      await workspace.archive(wsPath, { deleteBranch: true });

      expect(await pathExists(wsPath)).toBe(false);
      expect(await branchRefExists(sourcePath, "feature/pushed")).toBe(false);
    });

    it("deleteBranch: false (default) preserves the branch ref", async () => {
      const root = await tmp("git-archive-delbranch-default");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/keep",
      });

      await workspace.archive(wsPath);

      expect(await pathExists(wsPath)).toBe(false);
      // Regression guard: archive must not delete branches unless asked to.
      expect(await branchRefExists(sourcePath, "feature/keep")).toBe(true);
    });

    it("deleteBranch: true on a dirty worktree without force throws DirtyWorktreeError; branch untouched", async () => {
      const root = await tmp("git-archive-delbranch-dirty");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/del-dirty",
      });

      await writeUtf8(path.join(wsPath, "scratch.md"), "uncommitted\n");

      await expect(workspace.archive(wsPath, { deleteBranch: true })).rejects.toBeInstanceOf(
        DirtyWorktreeError,
      );

      expect(await pathExists(wsPath)).toBe(true);
      expect(await branchRefExists(sourcePath, "feature/del-dirty")).toBe(true);

      // Cleanup.
      await workspace.archive(wsPath, { force: true });
    });

    it("deleteBranch + force: true on a dirty worktree removes the worktree and the branch", async () => {
      const root = await tmp("git-archive-delbranch-force-dirty");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/del-force-dirty",
      });

      await writeUtf8(path.join(wsPath, "scratch.md"), "uncommitted\n");

      await workspace.archive(wsPath, { deleteBranch: true, force: true });

      expect(await pathExists(wsPath)).toBe(false);
      expect(await branchRefExists(sourcePath, "feature/del-force-dirty")).toBe(false);
    });

    it("deleteBranch: true on an UNMERGED branch with no upstream throws and preserves the branch (no silent loss)", async () => {
      const root = await tmp("git-archive-delbranch-unmerged");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      const ws = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/unmerged",
      });
      if (ws.kind !== "git") throw new Error("expected git workspace");

      // Commit real work on the branch. It's clean (committed) and has no
      // upstream, so status reports ahead: 0 and the dirty/ahead gate passes —
      // but the work isn't reachable from main. Safe `-d` must refuse.
      await writeUtf8(path.join(wsPath, "feature.ts"), "export const x = 1;\n");
      await ws.git.commit("add feature");

      await expect(workspace.archive(wsPath, { deleteBranch: true })).rejects.toThrow();

      // The safety guarantee: the branch ref (and its commits) survive the
      // failed safe-delete — no silent loss. The worktree dir was already
      // removed when the `-d` failed.
      expect(await pathExists(wsPath)).toBe(false);
      expect(await branchRefExists(sourcePath, "feature/unmerged")).toBe(true);

      // The path is now missing on disk, so re-archiving is the prune-only
      // no-op and does NOT retry the deletion — the branch persists until
      // removed directly. (Passing force on the first call would have deleted
      // it; here we clean up out-of-band.)
      await workspace.archive(wsPath, { source: sourcePath, deleteBranch: true });
      expect(await branchRefExists(sourcePath, "feature/unmerged")).toBe(true);

      await git(sourcePath, "branch", "-D", "feature/unmerged");
    });

    it("deleteBranch: true on a missing-on-disk path is a silent no-op (branch can't be read from a gone worktree)", async () => {
      const root = await tmp("git-archive-delbranch-missing");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/missing-path",
      });

      // User deleted the worktree dir out-of-band.
      await fs.rm(wsPath, { recursive: true, force: true });

      // Missing-on-disk path: archive prunes stale tracking but deleteBranch is
      // a documented no-op — there's no live HEAD to read the branch name from.
      await workspace.archive(wsPath, { source: sourcePath, deleteBranch: true });

      const { stdout } = await git(sourcePath, "worktree", "list");
      expect(stdout).not.toContain(wsPath);
      // The branch ref lingers (can't be resolved without the worktree).
      expect(await branchRefExists(sourcePath, "feature/missing-path")).toBe(true);
    });

    it("deleteBranch: true on a detached-HEAD worktree archives successfully (branch cleanup is a graceful no-op)", async () => {
      const root = await tmp("git-archive-delbranch-detached");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/detached",
      });

      // Detach HEAD in the worktree.
      await git(wsPath, "checkout", "--detach");

      // getCurrentBranch throws on detached HEAD → branch cleanup is skipped,
      // archive still succeeds.
      await workspace.archive(wsPath, { deleteBranch: true });
      expect(await pathExists(wsPath)).toBe(false);
    });
  });
});

/** True if `refs/heads/<branch>` exists in the repo at `repoPath`. */
async function branchRefExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}
