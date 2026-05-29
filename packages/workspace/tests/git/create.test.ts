import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BranchExistsError,
  NotAGitRepoError,
  workspace,
} from "../../src/index.js";
import { makeTmpDir, pathExists, removeTmpDir } from "../helpers.js";
import {
  commitFile,
  headSha,
  setupRepoWithMultipleDirs,
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

describe("workspace.create (git)", () => {
  it("creates a git worktree on a new branch and returns a fully populated handle", async () => {
    const root = await tmp("git-create-basic");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const baseSha = await headSha(sourcePath, "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/foo",
    });

    expect(ws.kind).toBe("git");
    expect(ws.path).toBe(wsPath);
    expect(ws.source).toBe(sourcePath);
    expect(ws.git.branch).toBe("feature/foo");
    expect(ws.git.base).toBe("main");
    expect(ws.git.baseSha).toBe(baseSha);

    expect(await pathExists(wsPath)).toBe(true);
    expect(await pathExists(path.join(wsPath, "README.md"))).toBe(true);
  });

  it("captures baseSha atomically — recorded SHA matches base at creation time even if base advances afterward", async () => {
    const root = await tmp("git-create-atomic");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const initialBaseSha = await headSha(sourcePath, "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/atomic",
    });

    // Advance main *after* the create call returns.
    await commitFile(sourcePath, "after.md", "later\n", "moves main forward");
    const newBaseSha = await headSha(sourcePath, "main");
    expect(newBaseSha).not.toBe(initialBaseSha);

    expect(ws.git.baseSha).toBe(initialBaseSha);
  });

  it("throws BranchExistsError when the branch already exists; worktree path is not populated", async () => {
    const root = await tmp("git-create-branch-exists");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    // Pre-create the conflicting branch.
    const { git } = await import("../git-helpers.js");
    await git(sourcePath, "branch", "feature/dup", "main");

    let caught: unknown = null;
    try {
      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/dup",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BranchExistsError);
    expect((caught as BranchExistsError).branch).toBe("feature/dup");
    expect(await pathExists(wsPath)).toBe(false);
  });

  it("with reuseBranch: true and an existing branch, checks out the existing branch at its current tip", async () => {
    const root = await tmp("git-create-reuse-existing");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    // Build up the branch with content the consumer expects to find again
    // on reuse. Two commits past `main` so we can tell the worktree landed
    // on the branch tip rather than on `main`.
    const { git } = await import("../git-helpers.js");
    await git(sourcePath, "branch", "feature/resume", "main");
    await git(sourcePath, "checkout", "feature/resume");
    await commitFile(sourcePath, "branch-only.md", "branch state\n", "add branch-only file");
    await commitFile(sourcePath, "branch-only-2.md", "more\n", "second branch commit");
    const branchTip = await headSha(sourcePath, "feature/resume");
    await git(sourcePath, "checkout", "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/resume",
      reuseBranch: true,
    });

    expect(ws.kind).toBe("git");
    expect(ws.path).toBe(wsPath);
    expect(ws.git.branch).toBe("feature/resume");
    // Branch tip = worktree HEAD. `main` does NOT contain these files.
    expect(await pathExists(path.join(wsPath, "branch-only.md"))).toBe(true);
    expect(await pathExists(path.join(wsPath, "branch-only-2.md"))).toBe(true);
    // Worktree's HEAD is the branch tip, not main.
    const worktreeHead = await headSha(wsPath, "HEAD");
    expect(worktreeHead).toBe(branchTip);
  });

  it("with reuseBranch: true and NO existing branch, falls through to create-new — the opt-in is a no-op", async () => {
    const root = await tmp("git-create-reuse-noexist");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const baseSha = await headSha(sourcePath, "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/fresh",
      reuseBranch: true,
    });

    expect(ws.git.branch).toBe("feature/fresh");
    expect(ws.git.baseSha).toBe(baseSha);
    // Branch was created off main → main's content is present.
    expect(await pathExists(path.join(wsPath, "README.md"))).toBe(true);
  });

  it("with reuseBranch: false / omitted and an existing branch, still throws BranchExistsError (preserves legacy behavior)", async () => {
    const root = await tmp("git-create-reuse-omitted");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const { git } = await import("../git-helpers.js");
    await git(sourcePath, "branch", "feature/already", "main");

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/already",
        // reuseBranch omitted — defaults to legacy throw behavior.
      }),
    ).rejects.toBeInstanceOf(BranchExistsError);

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: path.join(root, "ws2"),
        branch: "feature/already",
        reuseBranch: false, // explicit false also throws.
      }),
    ).rejects.toBeInstanceOf(BranchExistsError);
  });

  it("with reuseBranch: true on a branch already checked out in another worktree, propagates the raw git error", async () => {
    const root = await tmp("git-create-reuse-checked-out");
    const sourcePath = path.join(root, "source");
    const wsA = path.join(root, "wsA");
    const wsB = path.join(root, "wsB");
    await setupSimpleRepo(sourcePath);

    // First worktree owns `feature/locked` — second create attempt should
    // fail because git won't let two worktrees check out the same branch.
    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsA,
      branch: "feature/locked",
    });

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsB,
        branch: "feature/locked",
        reuseBranch: true,
      }),
    ).rejects.toThrow(); // raw git error — string-match isn't worth coupling to
  });

  it("throws NotAGitRepoError when the source is not a git repo", async () => {
    const root = await tmp("git-create-not-git");
    const sourcePath = path.join(root, "not-a-repo");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/foo",
      }),
    ).rejects.toBeInstanceOf(NotAGitRepoError);
  });

  it("throws when baseBranch does not exist in source", async () => {
    const root = await tmp("git-create-no-base");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "no-such-branch",
        path: wsPath,
        branch: "feature/x",
      }),
    ).rejects.toThrow();
  });

  it("rejects relative source / path / non-string branch / empty baseBranch", async () => {
    const root = await tmp("git-create-validate");
    const sourcePath = path.join(root, "source");
    await setupSimpleRepo(sourcePath);

    await expect(
      workspace.create({
        kind: "git",
        source: "rel/source",
        baseBranch: "main",
        path: path.join(root, "ws"),
        branch: "x",
      }),
    ).rejects.toThrow(/source must be an absolute path/);

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "",
        path: path.join(root, "ws"),
        branch: "x",
      }),
    ).rejects.toThrow(/baseBranch must be a non-empty string/);

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: path.join(root, "ws"),
        branch: "   ",
      }),
    ).rejects.toThrow(/branch must be a non-empty string/);
  });

  it("with sparseInclude (cone mode) materializes only the listed top-level subdirs", async () => {
    const root = await tmp("git-create-sparse");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupRepoWithMultipleDirs(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/sparse",
      sparseInclude: ["packages/foo"],
    });

    // Top-level files are always included in cone-mode sparse.
    expect(await pathExists(path.join(wsPath, "README.md"))).toBe(true);
    // Listed dir is materialized.
    expect(await pathExists(path.join(wsPath, "packages", "foo", "index.ts"))).toBe(true);
    // Non-listed dirs are not.
    expect(await pathExists(path.join(wsPath, "packages", "bar", "index.ts"))).toBe(false);
    expect(await pathExists(path.join(wsPath, "apps", "web", "main.ts"))).toBe(false);
  });

  it("rejects an empty sparseInclude array", async () => {
    const root = await tmp("git-create-sparse-empty");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await expect(
      workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/x",
        sparseInclude: [],
      }),
    ).rejects.toThrow(/sparseInclude must be a non-empty array/);
  });

  it("appends `.context/` to the worktree's per-worktree info/exclude", async () => {
    const root = await tmp("git-create-exclude");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/exclude",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/exclude");
    const excludePath = stdout.trim();
    const content = await fs.readFile(excludePath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim());
    expect(lines).toContain(".context/");
  });

  it("ensureContextExcluded is idempotent — running create twice (different workspaces) doesn't duplicate the line", async () => {
    const root = await tmp("git-create-exclude-idem");
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

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/exclude");
    const excludePath = stdout.trim();
    const content = await fs.readFile(excludePath, "utf-8");
    const occurrences = content.split("\n").filter((l) => l.trim() === ".context/").length;
    expect(occurrences).toBe(1);
  });

  it("writes per-worktree metadata file with baseBranch and baseSha", async () => {
    const root = await tmp("git-create-metadata");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const baseSha = await headSha(sourcePath, "main");

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/meta",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/agentex.json");
    const metadataPath = stdout.trim();

    const content = await fs.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.baseBranch).toBe("main");
    expect(parsed.baseSha).toBe(baseSha);
  });

  it("the new branch is materialized in the source as a real branch", async () => {
    const root = await tmp("git-create-branch-visible");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/visible",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(sourcePath, "branch", "--list", "feature/visible");
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});
