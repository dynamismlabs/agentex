import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { revParseGitDir, revParseGitPath } from "../../src/git/commands.js";
import { ensureContextExcluded } from "../../src/git/info-exclude.js";
import {
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from "../../src/git/metadata.js";
import { makeTmpDir, pathExists, removeTmpDir } from "../helpers.js";
import { addLinkedWorktree, git, headSha, setupSimpleRepo } from "../git-helpers.js";

/**
 * Regression suite for git-path resolution when the *process* cwd is not the
 * repository being operated on.
 *
 * `git rev-parse --git-dir` / `--git-path` print paths relative to the cwd
 * git ran in (for a normal checkout, `.git/...`). Node's `fs` resolves
 * relative paths against `process.cwd()`, so an unresolved result silently
 * points into whatever directory the host process happens to be sitting in —
 * the wrong repo's `.git/`, or (inside a linked worktree, where `.git` is a
 * file) a path that throws `ENOTDIR`.
 *
 * Every test here runs with `process.chdir()` pointed somewhere other than the
 * target repo. Vitest runs test files in forked child processes (not worker
 * threads), so `process.chdir` is available and isolated per file.
 */

const DECOY = { baseBranch: "decoy-branch", baseSha: "d".repeat(40) } as const;

interface Fixture {
  /** Normal checkout the library is asked to operate on. */
  target: string;
  /** Linked worktree of `target` (its `.git` is a pointer file). */
  targetWt: string;
  /** A *different* repository's normal checkout (`.git/` is a directory). */
  foreign: string;
  /** Linked worktree of `foreign` — the exact `ENOTDIR` repro location. */
  foreignWt: string;
  /** Not a git repository at all (holds a fake `.git/` of decoy files only). */
  plain: string;
}

const tmpDirs: string[] = [];
const originalCwd = process.cwd();
let fx: Fixture;

async function tmp(label: string): Promise<string> {
  const dir = await makeTmpDir(label);
  tmpDirs.push(dir);
  return dir;
}

/** Read the `gitdir:` target out of a linked worktree's `.git` pointer file. */
async function linkedGitDir(worktreePath: string): Promise<string> {
  const pointer = await fs.readFile(path.join(worktreePath, ".git"), "utf-8");
  const match = /^gitdir: (.+)$/m.exec(pointer);
  if (!match?.[1]) throw new Error(`no gitdir pointer in ${worktreePath}/.git`);
  return path.resolve(worktreePath, match[1].trim());
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/**
 * Plant decoy metadata + exclude files everywhere a cwd-relative
 * `.git/info/agentex.json`, `.git/agentex.json` or `.git/info/exclude` could
 * land from inside the foreign repo, its linked worktree, or the plain dir.
 */
async function plantDecoys(f: Fixture): Promise<void> {
  const foreignWtGitDir = await linkedGitDir(f.foreignWt);
  for (const gitDir of [path.join(f.foreign, ".git"), foreignWtGitDir, path.join(f.plain, ".git")]) {
    await writeJson(path.join(gitDir, "info", "agentex.json"), DECOY);
    await writeJson(path.join(gitDir, "agentex.json"), DECOY);
    await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(gitDir, "info", "exclude"), "# decoy exclude\n", "utf-8");
  }
}

/** Recursively capture every file under `dirs` (path → contents). */
async function snapshot(dirs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(p: string): Promise<void> {
    const stat = await fs.lstat(p).catch(() => null);
    if (stat === null) return;
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(p)) await walk(path.join(p, entry));
      return;
    }
    out.set(p, (await fs.readFile(p)).toString("base64"));
  }
  for (const d of dirs) await walk(d);
  return out;
}

/** Everything the buggy code could have touched outside the target repo. */
function foreignState(f: Fixture): Promise<Map<string, string>> {
  return snapshot([f.foreign, f.foreignWt, f.plain]);
}

beforeEach(async () => {
  const root = await tmp("foreign-cwd");
  fx = {
    target: path.join(root, "target"),
    targetWt: path.join(root, "target-wt"),
    foreign: path.join(root, "foreign"),
    foreignWt: path.join(root, "foreign-wt"),
    plain: path.join(root, "plain"),
  };
  await setupSimpleRepo(fx.target);
  await addLinkedWorktree(fx.target, fx.targetWt, "target-wt-branch");
  await setupSimpleRepo(fx.foreign);
  await addLinkedWorktree(fx.foreign, fx.foreignWt, "foreign-wt-branch");
  await fs.mkdir(fx.plain, { recursive: true });
  await plantDecoys(fx);

  // Preconditions the scenarios depend on.
  expect((await fs.lstat(path.join(fx.foreignWt, ".git"))).isFile()).toBe(true);
  await expect(git(fx.plain, "rev-parse", "--git-dir")).rejects.toThrow();
});

afterEach(async () => {
  process.chdir(originalCwd);
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

const TARGETS = [
  {
    label: "normal checkout",
    pick: (f: Fixture) => f.target,
    gitDir: async (f: Fixture) => path.join(f.target, ".git"),
  },
  {
    label: "linked worktree",
    pick: (f: Fixture) => f.targetWt,
    gitDir: (f: Fixture) => linkedGitDir(f.targetWt),
  },
] as const;

const FOREIGN_CWDS = [
  { label: "an unrelated plain directory", cwd: (f: Fixture) => f.plain },
  { label: "the root of another repo's linked worktree", cwd: (f: Fixture) => f.foreignWt },
  { label: "the root of another repo's normal checkout", cwd: (f: Fixture) => f.foreign },
] as const;

describe.each(FOREIGN_CWDS)("git paths resolve against the target repo when process cwd is $label", ({ cwd }) => {
  beforeEach(async () => {
    const dir = cwd(fx);
    process.chdir(dir);
    // Guard against a silently ignored chdir (e.g. a worker-thread pool).
    expect(await fs.realpath(process.cwd())).toBe(await fs.realpath(dir));
  });

  describe("revParseGitDir", () => {
    it.each(TARGETS)("returns the $label's absolute git dir", async ({ pick, gitDir }) => {
      const resolved = await revParseGitDir(pick(fx));
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toBe(await gitDir(fx));
    });
  });

  describe("revParseGitPath", () => {
    it("returns an absolute path inside a normal checkout's .git dir", async () => {
      const metadata = await revParseGitPath(fx.target, "info/agentex.json");
      expect(path.isAbsolute(metadata)).toBe(true);
      expect(metadata).toBe(path.join(fx.target, ".git", "info", "agentex.json"));

      const exclude = await revParseGitPath(fx.target, "info/exclude");
      expect(exclude).toBe(path.join(fx.target, ".git", "info", "exclude"));
    });

    it("returns absolute per-worktree and common paths for a linked worktree", async () => {
      const perWorktree = await revParseGitPath(fx.targetWt, "agentex.json");
      expect(path.isAbsolute(perWorktree)).toBe(true);
      expect(perWorktree).toBe(path.join(await linkedGitDir(fx.targetWt), "agentex.json"));

      // `info/` lives in the common dir, shared by every worktree of the repo.
      const common = await revParseGitPath(fx.targetWt, "info/exclude");
      expect(path.isAbsolute(common)).toBe(true);
      expect(common).toBe(path.join(fx.target, ".git", "info", "exclude"));
    });
  });

  describe("readWorktreeMetadata", () => {
    it.each(TARGETS)("returns null (no throw) for a $label without metadata, ignoring decoys", async ({ pick }) => {
      await expect(readWorktreeMetadata(pick(fx))).resolves.toBeNull();
    });

    it.each(TARGETS)("reads the $label's own metadata, never the cwd repo's decoy", async ({ pick, gitDir }) => {
      const own = { baseBranch: "main", baseSha: await headSha(fx.target, "main") };
      // Seed both the current and the legacy (<= 0.0.4) location so the
      // assertion is about *which repo* is read, not which file name.
      await writeJson(path.join(await gitDir(fx), "agentex.json"), own);
      await writeJson(path.join(fx.target, ".git", "info", "agentex.json"), own);

      await expect(readWorktreeMetadata(pick(fx))).resolves.toEqual(own);
    });
  });

  describe("writeWorktreeMetadata", () => {
    it.each(TARGETS)("writes into the $label's git dir and leaves the cwd repo untouched", async ({ pick, gitDir }) => {
      const before = await foreignState(fx);
      const own = { baseBranch: "main", baseSha: await headSha(fx.target, "main") };

      await writeWorktreeMetadata(pick(fx), own);

      const written = path.join(await gitDir(fx), "agentex.json");
      expect(JSON.parse(await fs.readFile(written, "utf-8"))).toEqual(own);
      expect(await foreignState(fx)).toEqual(before);
      await expect(readWorktreeMetadata(pick(fx))).resolves.toEqual(own);
    });
  });

  describe("ensureContextExcluded", () => {
    it("appends to the target repo's info/exclude and leaves the cwd repo untouched", async () => {
      const before = await foreignState(fx);

      await ensureContextExcluded(fx.targetWt);
      await ensureContextExcluded(fx.target);

      const exclude = await fs.readFile(path.join(fx.target, ".git", "info", "exclude"), "utf-8");
      expect(exclude.split("\n").filter((l) => l.trim() === ".context/")).toHaveLength(1);
      expect(await foreignState(fx)).toEqual(before);
    });
  });

  describe("workspace.open / workspace.create end to end", () => {
    it("opens a normal checkout with { source, baseBranch }", async () => {
      const before = await foreignState(fx);

      const ws = await workspace.open(fx.target, { source: fx.target, baseBranch: "main" });

      if (ws.kind !== "git") throw new Error("kind narrow failed");
      expect(ws.path).toBe(fx.target);
      expect(ws.git.base).toBe("main");
      expect(ws.git.baseSha).toBe(await headSha(fx.target, "main"));
      expect(ws.git.baseShaIsFreshlyDerived).toBe(true);
      expect(await foreignState(fx)).toEqual(before);
    });

    it("creates a worktree, then re-opens it from metadata alone", async () => {
      const before = await foreignState(fx);
      const wsPath = path.join(path.dirname(fx.target), "created-ws");
      const baseSha = await headSha(fx.target, "main");

      const created = await workspace.create({
        kind: "git",
        source: fx.target,
        baseBranch: "main",
        path: wsPath,
        branch: "feature/foreign-cwd",
      });
      const reopened = await workspace.open(wsPath);

      if (created.kind !== "git" || reopened.kind !== "git") throw new Error("kind narrow failed");
      expect(reopened.path).toBe(created.path);
      expect(reopened.source).toBe(fx.target);
      expect(reopened.git.branch).toBe("feature/foreign-cwd");
      expect(reopened.git.base).toBe("main");
      expect(reopened.git.baseSha).toBe(baseSha);
      expect(reopened.git.baseShaIsFreshlyDerived).toBeFalsy();

      const exclude = await fs.readFile(path.join(fx.target, ".git", "info", "exclude"), "utf-8");
      expect(exclude.split("\n").map((l) => l.trim())).toContain(".context/");
      expect(await foreignState(fx)).toEqual(before);

      await workspace.archive(wsPath);
      expect(await pathExists(wsPath)).toBe(false);
      expect(await foreignState(fx)).toEqual(before);
    });
  });
});
