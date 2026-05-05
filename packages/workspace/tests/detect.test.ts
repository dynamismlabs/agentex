import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import { makeTmpDir, removeTmpDir } from "./helpers.js";
import {
  addOrigin,
  git,
  initBareRemote,
  initRepo,
  pushBranch as remotePush,
  setupSimpleRepo,
} from "./git-helpers.js";

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

describe("workspace.detectKind", () => {
  it("returns 'bare' for a non-git directory", async () => {
    const root = await tmp("dk-bare");
    expect(await workspace.detectKind(root)).toBe("bare");
  });

  it("returns 'git' for a worktree (created by workspace.create)", async () => {
    const root = await tmp("dk-worktree");
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

    expect(await workspace.detectKind(wsPath)).toBe("git");
  });

  it("returns 'git' for the main repo (.git/ as a directory)", async () => {
    const root = await tmp("dk-main-repo");
    const repo = path.join(root, "main-repo");
    await setupSimpleRepo(repo);

    expect(await workspace.detectKind(repo)).toBe("git");
  });

  it("throws if the path does not exist", async () => {
    const root = await tmp("dk-missing");
    await expect(workspace.detectKind(path.join(root, "nope"))).rejects.toThrow(
      /does not exist/,
    );
  });

  it("rejects relative paths", async () => {
    await expect(workspace.detectKind("rel/path")).rejects.toThrow(/absolute/);
  });
});

describe("workspace.detectDefaultBranch", () => {
  it("resolves <remote>/HEAD when set", async () => {
    const root = await tmp("ddb-head");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    await setupSimpleRepo(sourcePath);
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");
    // Set origin/HEAD explicitly so the lookup succeeds even for fresh clones.
    await git(sourcePath, "remote", "set-head", "origin", "main");

    expect(await workspace.detectDefaultBranch(sourcePath)).toBe("main");
  });

  it("falls back to <remote>/main when HEAD is unset", async () => {
    const root = await tmp("ddb-main");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    await setupSimpleRepo(sourcePath);
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");

    // Remove origin/HEAD so the helper has to fall back.
    try {
      await git(sourcePath, "remote", "set-head", "origin", "--delete");
    } catch {
      // Some git versions don't auto-create HEAD; fine.
    }

    expect(await workspace.detectDefaultBranch(sourcePath)).toBe("main");
  });

  it("falls back to <remote>/master when neither HEAD nor main resolves", async () => {
    const root = await tmp("ddb-master");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    await initRepo(sourcePath);
    // Rename the initial branch to master to simulate an old-style repo.
    await git(sourcePath, "branch", "-m", "master");
    await git(sourcePath, "commit", "--allow-empty", "-m", "initial");

    await initBareRemote(remotePath);
    // Bare remote has HEAD → main; we'll push master and then push it as the
    // only branch.
    await addOrigin(sourcePath, remotePath);
    await git(sourcePath, "push", "-u", "origin", "master");

    try {
      await git(sourcePath, "remote", "set-head", "origin", "--delete");
    } catch {
      // ignore
    }

    expect(await workspace.detectDefaultBranch(sourcePath)).toBe("master");
  });

  it("falls back to local init.defaultBranch when no remote refs match", async () => {
    const root = await tmp("ddb-config");
    const sourcePath = path.join(root, "source");
    await setupSimpleRepo(sourcePath);
    await git(sourcePath, "config", "init.defaultBranch", "trunk");

    // No remote configured → all remote checks fail → falls to config.
    expect(await workspace.detectDefaultBranch(sourcePath)).toBe("trunk");
  });

  it("supports custom remote names (not just 'origin')", async () => {
    const root = await tmp("ddb-custom-remote");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "upstream.git");
    await setupSimpleRepo(sourcePath);
    await initBareRemote(remotePath);
    await git(sourcePath, "remote", "add", "upstream", remotePath);
    await git(sourcePath, "push", "-u", "upstream", "main");
    await git(sourcePath, "remote", "set-head", "upstream", "main");

    expect(await workspace.detectDefaultBranch(sourcePath, "upstream")).toBe("main");
  });

  it("rejects relative paths", async () => {
    await expect(workspace.detectDefaultBranch("rel")).rejects.toThrow(/absolute/);
  });
});
