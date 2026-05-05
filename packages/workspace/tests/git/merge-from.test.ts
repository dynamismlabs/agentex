import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { MergeConflictError, workspace } from "../../src/index.js";
import { makeTmpDir, pathExists, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
import { commitFile, git, initRepo } from "../git-helpers.js";

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
 * Build a source repo with a `develop` branch + a `feature/x` branch that has
 * a non-conflicting commit. The workspace is created on `develop`; the test
 * merges `feature/x` into it.
 */
async function makeRepoWithFeatureBranch(label: string, opts: { conflict?: boolean } = {}) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const wsPath = path.join(root, "ws");

  await initRepo(sourcePath);
  await commitFile(sourcePath, "shared.txt", "alpha\n", "initial");
  await git(sourcePath, "branch", "develop");

  // feature/x branch with content that may or may not conflict.
  await git(sourcePath, "checkout", "-b", "feature/x");
  if (opts.conflict) {
    await commitFile(sourcePath, "shared.txt", "feature-version\n", "feature changes shared");
  } else {
    await commitFile(sourcePath, "feature-only.txt", "ff\n", "feature adds new file");
  }
  await git(sourcePath, "checkout", "main");

  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "develop",
    path: wsPath,
    branch: "merge-target",
  });
  if (ws.kind !== "git") throw new Error("expected git");

  // Park the worktree on develop so the merge-from feature/x lands there.
  await ws.git.checkout("develop");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.mergeFrom", () => {
  it("merge strategy: integrates a non-conflicting branch into the current branch", async () => {
    const { wsPath, ws } = await makeRepoWithFeatureBranch("mf-merge");

    await ws.git.mergeFrom("feature/x");

    expect(await pathExists(path.join(wsPath, "feature-only.txt"))).toBe(true);

    // Most recent commit should be the merge or the picked-up commit.
    const log = await ws.git.raw(["log", "-3", "--pretty=%s"]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("feature adds new file");
  });

  it("rebase strategy: replays nothing onto feature/x because target has no unique commits", async () => {
    // For rebase, we put divergent commits on develop AND feature/x, then
    // rebase feature/x onto develop's tip. Easier: make divergent local commit
    // on develop, then rebase feature/x onto it.
    const { wsPath, ws } = await makeRepoWithFeatureBranch("mf-rebase");

    await writeUtf8(path.join(wsPath, "develop-only.txt"), "d\n");
    await ws.git.commit("develop's local change");

    await ws.git.mergeFrom("feature/x", { strategy: "rebase" });

    // After rebase onto feature/x, both files should be present and the
    // top-most commit should be develop's "develop's local change" (replayed
    // on top of feature/x).
    expect(await pathExists(path.join(wsPath, "feature-only.txt"))).toBe(true);
    expect(await pathExists(path.join(wsPath, "develop-only.txt"))).toBe(true);

    const log = await ws.git.raw(["log", "--pretty=%s"]);
    expect(log.stdout.split("\n")[0]).toBe("develop's local change");
  });

  it("throws MergeConflictError on conflict; leaves the worktree in conflict state", async () => {
    const { wsPath, ws } = await makeRepoWithFeatureBranch("mf-conflict", { conflict: true });

    // Make a conflicting commit on develop too so merging feature/x conflicts.
    await writeUtf8(path.join(wsPath, "shared.txt"), "develop-version\n");
    await ws.git.commit("develop conflicts with feature");

    let caught: unknown = null;
    try {
      await ws.git.mergeFrom("feature/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MergeConflictError);
    expect((caught as MergeConflictError).files).toContain("shared.txt");

    // Conflict markers should be present in the file.
    const content = await readUtf8(path.join(wsPath, "shared.txt"));
    expect(content).toMatch(/<<<<<<</);
  });

  it("rejects empty ref", async () => {
    const { ws } = await makeRepoWithFeatureBranch("mf-validate");
    await expect(ws.git.mergeFrom("")).rejects.toThrow(/non-empty/);
  });
});
