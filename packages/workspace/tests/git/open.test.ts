import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir } from "../helpers.js";
import { headSha, setupSimpleRepo } from "../git-helpers.js";

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
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/agentex.json");
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
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/agentex.json");
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
    const { stdout } = await git(wsPath, "rev-parse", "--git-path", "info/agentex.json");
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
});
