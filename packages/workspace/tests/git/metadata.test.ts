import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { readWorktreeMetadata } from "../../src/git/metadata.js";
import { makeTmpDir, pathExists, removeTmpDir } from "../helpers.js";
import {
  addLinkedWorktree,
  commitFile,
  createBranch,
  git,
  headSha,
  setupSimpleRepo,
} from "../git-helpers.js";

/**
 * Where `@agentex/workspace` keeps its create-time `{ baseBranch, baseSha }`.
 *
 * It must be *per worktree*: `git rev-parse --git-path info/...` resolves into
 * the repository's shared common dir (git treats `info/` as common to every
 * worktree), so metadata stored there is clobbered by each sibling `create`.
 * Metadata lives at `--git-path agentex.json` instead — the worktree's own
 * admin dir (`.git/worktrees/<name>/`), which `git worktree remove` deletes.
 */

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

async function gitPath(cwd: string, rel: string): Promise<string> {
  const { stdout } = await git(cwd, "rev-parse", "--git-path", rel);
  return path.resolve(cwd, stdout.trim());
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** A source repo whose `main` and `dev` branches point at different commits. */
async function setupDivergedSource(sourcePath: string): Promise<{ mainSha: string; devSha: string }> {
  await setupSimpleRepo(sourcePath);
  await createBranch(sourcePath, "dev", "main");
  await commitFile(sourcePath, "main-only.txt", "main\n", "main-only commit");
  const mainSha = await headSha(sourcePath, "main");
  const devSha = await headSha(sourcePath, "dev");
  expect(mainSha).not.toBe(devSha);
  return { mainSha, devSha };
}

describe("worktree metadata (per-worktree storage)", () => {
  it("sibling worktrees of one source keep independent base metadata", async () => {
    const root = await tmp("meta-siblings");
    const sourcePath = path.join(root, "source");
    const { mainSha, devSha } = await setupDivergedSource(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: path.join(root, "ws-a"),
      branch: "feature/a",
    });
    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "dev",
      path: path.join(root, "ws-b"),
      branch: "feature/b",
    });

    const a = await workspace.open(path.join(root, "ws-a"));
    const b = await workspace.open(path.join(root, "ws-b"));
    if (a.kind !== "git" || b.kind !== "git") throw new Error("kind narrow failed");

    expect(a.git.base).toBe("main");
    expect(a.git.baseSha).toBe(mainSha);
    expect(b.git.base).toBe("dev");
    expect(b.git.baseSha).toBe(devSha);
  });

  it("stores metadata in the worktree's own git dir — not the shared common dir — and archive removes it", async () => {
    const root = await tmp("meta-location");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/location",
    });

    const { stdout } = await git(wsPath, "rev-parse", "--git-dir");
    const worktreeGitDir = path.resolve(wsPath, stdout.trim());
    const metadataPath = path.join(worktreeGitDir, "agentex.json");
    expect(worktreeGitDir.startsWith(path.join(sourcePath, ".git", "worktrees") + path.sep)).toBe(true);
    expect(await gitPath(wsPath, "agentex.json")).toBe(metadataPath);
    expect(await pathExists(metadataPath)).toBe(true);
    expect(await pathExists(path.join(sourcePath, ".git", "info", "agentex.json"))).toBe(false);
    expect(await pathExists(path.join(sourcePath, ".git", "agentex.json"))).toBe(false);

    await workspace.archive(wsPath);
    expect(await pathExists(metadataPath)).toBe(false);
  });

  it("falls back to the legacy shared info/agentex.json for worktrees created by <= 0.0.4", async () => {
    const root = await tmp("meta-legacy");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    await addLinkedWorktree(sourcePath, wsPath, "feature/legacy");
    const baseSha = await headSha(sourcePath, "main");
    await writeJson(path.join(sourcePath, ".git", "info", "agentex.json"), {
      baseBranch: "main",
      baseSha,
    });

    const ws = await workspace.open(wsPath);
    if (ws.kind !== "git") throw new Error("kind narrow failed");
    expect(ws.git.base).toBe("main");
    expect(ws.git.baseSha).toBe(baseSha);
    expect(ws.git.baseShaIsFreshlyDerived).toBeFalsy();
  });

  it("per-worktree metadata wins over the legacy shared file", async () => {
    const root = await tmp("meta-precedence");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    const { mainSha, devSha } = await setupDivergedSource(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/precedence",
    });
    await writeJson(path.join(sourcePath, ".git", "info", "agentex.json"), {
      baseBranch: "dev",
      baseSha: devSha,
    });

    await expect(readWorktreeMetadata(wsPath)).resolves.toEqual({
      baseBranch: "main",
      baseSha: mainSha,
    });
  });

  it("a normal checkout never adopts the legacy shared file (it always belonged to a linked worktree)", async () => {
    const root = await tmp("meta-main-checkout");
    const sourcePath = path.join(root, "source");
    const { mainSha, devSha } = await setupDivergedSource(sourcePath);
    await writeJson(path.join(sourcePath, ".git", "info", "agentex.json"), {
      baseBranch: "dev",
      baseSha: devSha,
    });

    await expect(readWorktreeMetadata(sourcePath)).resolves.toBeNull();

    const ws = await workspace.open(sourcePath, { source: sourcePath, baseBranch: "main" });
    if (ws.kind !== "git") throw new Error("kind narrow failed");
    expect(ws.git.base).toBe("main");
    expect(ws.git.baseSha).toBe(mainSha);
    expect(ws.git.baseShaIsFreshlyDerived).toBe(true);
  });

  it("surfaces unreadable metadata instead of masking it (malformed JSON rethrows)", async () => {
    const root = await tmp("meta-malformed");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/malformed",
    });
    await fs.writeFile(await gitPath(wsPath, "agentex.json"), "{ not json", "utf-8");

    await expect(readWorktreeMetadata(wsPath)).rejects.toThrow(SyntaxError);
  });
});
