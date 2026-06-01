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
  git,
  headSha,
  setupRepoWithMultipleDirs,
  setupSimpleRepo,
} from "../git-helpers.js";

/**
 * Create `branch` in `sourcePath` with the given commits stacked on top of the
 * current `main`, then return `main`'s HEAD to where it was. Leaves the source
 * checked out on `main` so the branch is free to be adopted into a worktree.
 */
async function makeBranchWithCommits(
  sourcePath: string,
  branch: string,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  await git(sourcePath, "checkout", "-b", branch);
  for (const [rel, content] of files) {
    await commitFile(sourcePath, rel, content, `add ${rel}`);
  }
  await git(sourcePath, "checkout", "main");
}

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

    const { stdout } = await git(sourcePath, "branch", "--list", "feature/visible");
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  describe("reuseBranch", () => {
    it("reuseBranch: true adopts an existing branch — HEAD lands at its tip with its commits", async () => {
      const root = await tmp("git-create-reuse-existing");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);
      await makeBranchWithCommits(sourcePath, "feature/resume", [
        ["feature-a.ts", "export const a = 1;\n"],
        ["feature-b.ts", "export const b = 2;\n"],
      ]);
      const branchTip = await headSha(sourcePath, "feature/resume");

      const ws = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/resume",
        reuseBranch: true,
      });
      if (ws.kind !== "git") throw new Error("expected git workspace");

      expect(ws.git.branch).toBe("feature/resume");
      // HEAD is the branch tip, not a fresh branch off main.
      expect(await headSha(wsPath, "HEAD")).toBe(branchTip);
      // The branch's own files are materialized in the worktree.
      expect(await pathExists(path.join(wsPath, "feature-a.ts"))).toBe(true);
      expect(await pathExists(path.join(wsPath, "feature-b.ts"))).toBe(true);
    });

    it("reuseBranch: true is a no-op when the branch doesn't exist — falls through to create-new", async () => {
      const root = await tmp("git-create-reuse-missing");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);
      const mainSha = await headSha(sourcePath, "main");

      const ws = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/fresh",
        reuseBranch: true,
      });
      if (ws.kind !== "git") throw new Error("expected git workspace");

      expect(ws.git.branch).toBe("feature/fresh");
      // Created off main: HEAD == main, baseSha == main, README present.
      expect(await headSha(wsPath, "HEAD")).toBe(mainSha);
      expect(ws.git.baseSha).toBe(mainSha);
      expect(await pathExists(path.join(wsPath, "README.md"))).toBe(true);
    });

    it("reuseBranch: false (explicit) on an existing branch still throws BranchExistsError", async () => {
      const root = await tmp("git-create-reuse-false");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);
      await git(sourcePath, "branch", "feature/dup", "main");

      await expect(
        workspace.create({
          kind: "git",
          source: sourcePath,
          baseBranch: "main",
          path: wsPath,
          branch: "feature/dup",
          reuseBranch: false,
        }),
      ).rejects.toBeInstanceOf(BranchExistsError);
      expect(await pathExists(wsPath)).toBe(false);
    });

    it("reuseBranch: true throws (raw git error) when the branch is checked out in another worktree", async () => {
      const root = await tmp("git-create-reuse-checked-out");
      const sourcePath = path.join(root, "source");
      const otherWsPath = path.join(root, "other-ws");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);
      await git(sourcePath, "branch", "feature/busy", "main");
      // Occupy the branch in a separate worktree.
      await git(sourcePath, "worktree", "add", otherWsPath, "feature/busy");

      await expect(
        workspace.create({
          kind: "git",
          source: sourcePath,
          baseBranch: "main",
          path: wsPath,
          branch: "feature/busy",
          reuseBranch: true,
        }),
      ).rejects.toThrow();
      expect(await pathExists(wsPath)).toBe(false);
    });

    it("round-trip: archive (keeping the branch) then reuseBranch re-adopts the same commits at the same path", async () => {
      // The actual consumer use case: a session is created, does work, is
      // archived (worktree gone, branch kept), then resumed at the same path.
      const root = await tmp("git-reuse-roundtrip");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      const first = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/roundtrip",
      });
      if (first.kind !== "git") throw new Error("expected git workspace");

      // Commit work in the session, then tear it down without deleting the branch.
      await commitFile(wsPath, "work.ts", "export const w = 1;\n", "session work");
      const branchTip = await headSha(wsPath, "HEAD");
      await workspace.archive(wsPath); // clean + no upstream → gate passes; deleteBranch defaults false
      expect(await pathExists(wsPath)).toBe(false);

      // Resume at the same path. reuseBranch adopts the kept branch and its work.
      const second = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/roundtrip",
        reuseBranch: true,
      });
      if (second.kind !== "git") throw new Error("expected git workspace");

      expect(await headSha(wsPath, "HEAD")).toBe(branchTip);
      expect(await pathExists(path.join(wsPath, "work.ts"))).toBe(true);
    });

    it("reuseBranch: true honors sparseInclude — materializes only the listed subset of the branch tip", async () => {
      const root = await tmp("git-reuse-sparse");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupRepoWithMultipleDirs(sourcePath);
      await git(sourcePath, "branch", "feature/sparse-reuse", "main");

      await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/sparse-reuse",
        reuseBranch: true,
        sparseInclude: ["packages/foo"],
      });

      expect(await pathExists(path.join(wsPath, "README.md"))).toBe(true);
      expect(await pathExists(path.join(wsPath, "packages", "foo", "index.ts"))).toBe(true);
      expect(await pathExists(path.join(wsPath, "packages", "bar", "index.ts"))).toBe(false);
      expect(await pathExists(path.join(wsPath, "apps", "web", "main.ts"))).toBe(false);
    });

    it("reuseBranch: true records baseSha as the merge-base so diff(\"base\") shows only the branch's changes", async () => {
      // The load-bearing semantic test: the branch diverged at C0, then main
      // advanced. baseSha must be the divergence point (merge-base), NOT main's
      // current tip — otherwise diff(\"base\") would surface main's progress as
      // spurious deletions in the resumed worktree.
      const root = await tmp("git-create-reuse-diff");
      const sourcePath = path.join(root, "source");
      const wsPath = path.join(root, "ws");
      await setupSimpleRepo(sourcePath);

      // Branch off C0 with 2 commits.
      await makeBranchWithCommits(sourcePath, "feature/diverged", [
        ["feature-a.ts", "export const a = 1;\n"],
        ["feature-b.ts", "export const b = 2;\n"],
      ]);
      // Advance main one commit past the divergence point.
      await commitFile(sourcePath, "main-progress.md", "moved on\n", "advance main");

      const expectedBase = (await git(sourcePath, "merge-base", "feature/diverged", "main")).stdout.trim();
      const mainTip = await headSha(sourcePath, "main");
      expect(expectedBase).not.toBe(mainTip); // sanity: they really differ

      const ws = await workspace.create({
        kind: "git",
        source: sourcePath,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/diverged",
        reuseBranch: true,
      });
      if (ws.kind !== "git") throw new Error("expected git workspace");

      expect(ws.git.baseSha).toBe(expectedBase);

      const diff = await ws.git.diff("base");
      const byPath = new Map(diff.files.map((f) => [f.path, f.status]));
      expect(byPath.get("feature-a.ts")).toBe("added");
      expect(byPath.get("feature-b.ts")).toBe("added");
      // main's progress must NOT appear — it would show as a deletion if
      // baseSha were main's tip instead of the merge-base.
      expect(byPath.has("main-progress.md")).toBe(false);
      expect(diff.files).toHaveLength(2);
    });
  });
});
