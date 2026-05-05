import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { RemoteAlreadyExistsError, workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import { git, initBareRemote, setupSimpleRepo } from "../git-helpers.js";

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

async function makeGitWorkspace(label: string) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const wsPath = path.join(root, "ws");
  await setupSimpleRepo(sourcePath);
  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "main",
    path: wsPath,
    branch: "feature/remotes",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.addRemote / setOrigin", () => {
  it("addRemote adds a new remote", async () => {
    const { wsPath, ws } = await makeGitWorkspace("rm-add");
    const fakeUrl = "git@github.com:owner/repo.git";

    await ws.git.addRemote("origin", fakeUrl);

    const r = await git(wsPath, "remote", "get-url", "origin");
    expect(r.stdout.trim()).toBe(fakeUrl);
  });

  it("addRemote throws RemoteAlreadyExistsError when the remote name is taken", async () => {
    const { ws } = await makeGitWorkspace("rm-add-dup");
    await ws.git.addRemote("upstream", "git@github.com:a/b.git");

    let caught: unknown = null;
    try {
      await ws.git.addRemote("upstream", "git@github.com:c/d.git");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteAlreadyExistsError);
    expect((caught as RemoteAlreadyExistsError).remote).toBe("upstream");
  });

  it("addRemote rejects empty name / url", async () => {
    const { ws } = await makeGitWorkspace("rm-add-validate");
    await expect(ws.git.addRemote("", "git@x:y.git")).rejects.toThrow(/non-empty/);
    await expect(ws.git.addRemote("origin", "")).rejects.toThrow(/non-empty/);
  });

  it("setOrigin upserts: creates origin when missing", async () => {
    const { wsPath, ws } = await makeGitWorkspace("rm-setorigin-create");
    const url = "git@github.com:owner/new.git";

    await ws.git.setOrigin(url);

    const r = await git(wsPath, "remote", "get-url", "origin");
    expect(r.stdout.trim()).toBe(url);
  });

  it("setOrigin upserts: updates the URL when origin already exists", async () => {
    const { wsPath, ws } = await makeGitWorkspace("rm-setorigin-update");
    await ws.git.addRemote("origin", "git@github.com:owner/old.git");

    const newUrl = "git@github.com:owner/updated.git";
    await ws.git.setOrigin(newUrl);

    const r = await git(wsPath, "remote", "get-url", "origin");
    expect(r.stdout.trim()).toBe(newUrl);
  });

  it("setOrigin enables push: addRemote → setOrigin → push to a fresh bare remote works", async () => {
    const root = await tmp("rm-setorigin-push");
    const sourcePath = path.join(root, "source");
    const remotePath = path.join(root, "remote.git");
    const wsPath = path.join(root, "ws");

    // Source has no remote configured at all.
    await setupSimpleRepo(sourcePath);
    await initBareRemote(remotePath);

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/bootstrap",
    });
    if (ws.kind !== "git") throw new Error("expected git workspace");

    // Bootstrap origin from scratch, then push.
    await ws.git.setOrigin(remotePath);
    await writeUtf8(path.join(wsPath, "fresh.txt"), "v\n");
    await ws.git.commit("first commit");
    await ws.git.push();

    // Branch should now exist on the remote.
    const branches = await git(remotePath, "branch", "--list", "feature/bootstrap");
    expect(branches.stdout.trim().length).toBeGreaterThan(0);
  });
});
