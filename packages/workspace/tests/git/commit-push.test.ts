import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import {
  addOrigin,
  git,
  initBareRemote,
  pushBranch as remotePush,
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

async function makeGitWorkspace(label: string, includeRemote: boolean) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const wsPath = path.join(root, "ws");
  await setupSimpleRepo(sourcePath);

  let remotePath: string | undefined;
  if (includeRemote) {
    remotePath = path.join(root, "remote.git");
    await initBareRemote(remotePath);
    await addOrigin(sourcePath, remotePath);
    await remotePush(sourcePath, "main");
  }

  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "main",
    path: wsPath,
    branch: "feature/commit-push",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, remotePath, wsPath, ws };
}

describe("ws.git.commit", () => {
  it("stages all changes (tracked + untracked) and commits", async () => {
    const { wsPath, ws } = await makeGitWorkspace("commit-all", false);

    await writeUtf8(path.join(wsPath, "new.ts"), "export const x = 1;\n");
    await writeUtf8(path.join(wsPath, "README.md"), "# changed\n");

    await ws.git.commit("test commit");

    const status = await ws.git.status();
    expect(status.dirty).toBe(false);

    const { stdout } = await git(wsPath, "log", "-1", "--pretty=%s");
    expect(stdout.trim()).toBe("test commit");
  });

  it("throws on empty/whitespace message", async () => {
    const { wsPath, ws } = await makeGitWorkspace("commit-empty", false);
    await writeUtf8(path.join(wsPath, "new.ts"), "x\n");

    await expect(ws.git.commit("")).rejects.toThrow(/non-empty/);
    await expect(ws.git.commit("   ")).rejects.toThrow(/non-empty/);
  });

  it("throws when there is nothing to commit (clean workspace)", async () => {
    const { ws } = await makeGitWorkspace("commit-nothing", false);
    await expect(ws.git.commit("nothing")).rejects.toThrow(/nothing to commit/);
  });
});

describe("ws.git.push", () => {
  it("first push sets upstream and pushes the branch", async () => {
    const { remotePath, wsPath, ws } = await makeGitWorkspace("push-first", true);
    if (!remotePath) throw new Error("expected remote");

    await writeUtf8(path.join(wsPath, "new.ts"), "export const x = 1;\n");
    await ws.git.commit("first commit");

    await ws.git.push();

    // Verify the branch exists on the remote.
    const { stdout } = await git(remotePath, "branch", "--list", "feature/commit-push");
    expect(stdout.trim().length).toBeGreaterThan(0);

    // Status should now show ahead=0, behind=0.
    const status = await ws.git.status();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("subsequent push (upstream already set) succeeds", async () => {
    const { wsPath, ws } = await makeGitWorkspace("push-second", true);

    await writeUtf8(path.join(wsPath, "a.ts"), "1\n");
    await ws.git.commit("a");
    await ws.git.push();

    await writeUtf8(path.join(wsPath, "b.ts"), "2\n");
    await ws.git.commit("b");
    await ws.git.push();

    const status = await ws.git.status();
    expect(status.ahead).toBe(0);
  });
});
