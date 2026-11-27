import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, pathExists, removeTmpDir, writeUtf8 } from "../helpers.js";
import { commitFile, git, headSha, setupSimpleRepo } from "../git-helpers.js";

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

describe("workspace.open (git)", () => {
  it("re-hydrates handle after create — path, source, branch, base, baseSha all match", async () => {
    const root = await tmp("git-open-roundtrip");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const created = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/round",
    });

    const reopened = await workspace.open(wsPath);

    expect(reopened.kind).toBe("git");
    expect(reopened.path).toBe(created.path);
    expect(reopened.source).toBe(created.source);
    if (reopened.kind !== "git") throw new Error("kind narrow failed");
    expect(reopened.git.branch).toBe(created.git.branch);
    expect(reopened.git.base).toBe(created.git.base);
    expect(reopened.git.baseSha).toBe(created.git.baseSha);
  });

  it("opts.source overrides the auto-resolved source", async () => {
    const root = await tmp("git-open-source-override");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/override",
    });

    // The override path doesn't have to be a real source — slice 2 just records it.
    const overrideSource = path.join(root, "fake-source");
    await fs.mkdir(overrideSource, { recursive: true });
    const reopened = await workspace.open(wsPath, { source: overrideSource });

    expect(reopened.source).toBe(overrideSource);
  });

  it("opts.baseBranch + opts.baseSha override the metadata file", async () => {
    const root = await tmp("git-open-base-override");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/base-override",
    });

    const reopened = await workspace.open(wsPath, {
      baseBranch: "release",
      baseSha: "0000000000000000000000000000000000000000",
    });

    if (reopened.kind !== "git") throw new Error("kind narrow failed");
    expect(reopened.git.base).toBe("release");
    expect(reopened.git.baseSha).toBe("0000000000000000000000000000000000000000");
  });

  it("throws when the metadata file is missing AND no baseBranch override is supplied", async () => {
    const root = await tmp("git-open-no-meta");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/no-meta",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "agentex.json");
    await fs.unlink(stdout.trim());

    await expect(workspace.open(wsPath)).rejects.toThrow(/no base metadata/);
  });

  it("succeeds when metadata is missing but baseBranch + baseSha are passed in opts", async () => {
    const root = await tmp("git-open-no-meta-override");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const baseSha = await headSha(sourcePath, "main");

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/recovery",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "agentex.json");
    await fs.unlink(stdout.trim());

    const reopened = await workspace.open(wsPath, {
      baseBranch: "main",
      baseSha,
    });

    if (reopened.kind !== "git") throw new Error("kind narrow failed");
    expect(reopened.git.base).toBe("main");
    expect(reopened.git.baseSha).toBe(baseSha);
    expect(reopened.git.baseShaIsFreshlyDerived).toBeFalsy();
  });

  it("auto-derives baseSha from baseBranch when metadata is missing; flags it as freshly derived", async () => {
    const root = await tmp("git-open-fresh-derive");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/fresh",
    });

    const { git } = await import("../git-helpers.js");
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "agentex.json");
    await fs.unlink(stdout.trim());

    const expectedSha = await headSha(sourcePath, "main");

    // Open with baseBranch only — baseSha should be derived freshly from
    // `git rev-parse main` and the handle should advertise that.
    const reopened = await workspace.open(wsPath, { baseBranch: "main" });
    if (reopened.kind !== "git") throw new Error("kind narrow failed");

    expect(reopened.git.base).toBe("main");
    expect(reopened.git.baseSha).toBe(expectedSha);
    expect(reopened.git.baseShaIsFreshlyDerived).toBe(true);
  });

  it("auto-resolves source from the worktree's .git pointer", async () => {
    const root = await tmp("git-open-source-auto");
    const sourcePath = path.join(root, "deep", "source");
    const wsPath = path.join(root, "elsewhere", "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/auto",
    });

    const reopened = await workspace.open(wsPath);
    // Use realpath to compare — macOS tmpdir lives behind /var → /private/var symlink.
    const expectedReal = await fs.realpath(sourcePath);
    const actualReal = await fs.realpath(reopened.source);
    expect(actualReal).toBe(expectedReal);
  });

  // An agent reviewing a pull request checks out the remote branch or a
  // commit directly. The worktree must still open, so its files, status and
  // diff stay readable and it can be archived.
  it("opens a worktree on a detached HEAD: branch is null, status and diff still work", async () => {
    const root = await tmp("git-open-detached");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const created = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/review",
    });
    if (created.kind !== "git") throw new Error("kind narrow failed");
    const reviewed = await commitFile(wsPath, "reviewed.ts", "export const x = 1;\n", "the change under review");
    await git(wsPath, "checkout", "--detach", reviewed);
    await writeUtf8(path.join(wsPath, "notes.md"), "review notes\n");

    const reopened = await workspace.open(wsPath);
    if (reopened.kind !== "git") throw new Error("kind narrow failed");

    expect(reopened.git.branch).toBeNull();
    expect(reopened.git.base).toBe("main");
    expect(reopened.git.baseSha).toBe(created.git.baseSha);
    const status = await reopened.git.status();
    expect(status.dirty).toBe(true);
    expect(status.untracked).toEqual(["notes.md"]);
    const diff = await reopened.git.diff("base");
    expect(diff.files.map((f) => f.path).sort()).toEqual(["notes.md", "reviewed.ts"]);

    await workspace.archive(wsPath, { force: true });
    expect(await pathExists(wsPath)).toBe(false);
  });

  it("still throws when the path is not a working git checkout", async () => {
    const root = await tmp("git-open-broken-link");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/broken",
    });
    // The worktree's `.git` file now points at a gitdir that doesn't exist.
    await fs.writeFile(path.join(wsPath, ".git"), `gitdir: ${path.join(root, "gone")}\n`);

    await expect(workspace.open(wsPath, { source: sourcePath })).rejects.toThrow();
  });
});
