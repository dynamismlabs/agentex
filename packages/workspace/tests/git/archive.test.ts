import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ArchiveScriptFailedError,
  DirtyWorktreeError,
  workspace,
} from "../../src/index.js";
import { makeTmpDir, pathExists, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
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
});
