import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, readUtf8, removeTmpDir, writeUtf8 } from "../helpers.js";
import { commitFile, git, initRepo, setupSimpleRepo } from "../git-helpers.js";

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

describe("ws.git.checkout", () => {
  it("switches HEAD to an existing branch", async () => {
    const root = await tmp("co-existing-branch");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");

    await initRepo(sourcePath);
    await commitFile(sourcePath, "file.txt", "v1\n", "initial on main");
    // A second branch in source so the worktree can switch to it.
    await git(sourcePath, "branch", "develop");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/co",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await ws.git.checkout("develop");

    const r = await git(wsPath, "rev-parse", "--abbrev-ref", "HEAD");
    expect(r.stdout.trim()).toBe("develop");
  });

  it("switches to a SHA (detached HEAD)", async () => {
    const root = await tmp("co-sha");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");

    await initRepo(sourcePath);
    const sha = await commitFile(sourcePath, "x.txt", "x\n", "initial");
    await commitFile(sourcePath, "y.txt", "y\n", "second");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/sha",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await ws.git.checkout(sha);

    const head = await git(wsPath, "rev-parse", "HEAD");
    expect(head.stdout.trim()).toBe(sha);
  });

  it("rejects empty ref", async () => {
    const root = await tmp("co-validate");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/validate",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    await expect(ws.git.checkout("")).rejects.toThrow(/non-empty/);
  });

  it("surfaces git's own error when uncommitted changes would be overwritten", async () => {
    const root = await tmp("co-conflict");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");

    await initRepo(sourcePath);
    await commitFile(sourcePath, "shared.txt", "v1\n", "initial");
    // A second branch with a different version of the same file.
    await git(sourcePath, "branch", "develop");
    await git(sourcePath, "checkout", "develop");
    await commitFile(sourcePath, "shared.txt", "develop-version\n", "develop change");
    await git(sourcePath, "checkout", "main");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/dirty",
    });
    if (ws.kind !== "git") throw new Error("expected git");

    // Make a conflicting uncommitted local change to shared.txt.
    await writeUtf8(path.join(wsPath, "shared.txt"), "local-uncommitted\n");

    await expect(ws.git.checkout("develop")).rejects.toThrow();

    // Local content preserved (git refused).
    expect(await readUtf8(path.join(wsPath, "shared.txt"))).toBe("local-uncommitted\n");
  });
});
