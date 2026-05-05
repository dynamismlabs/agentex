import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import { setupSimpleRepo } from "../git-helpers.js";

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
    branch: "feature/shortstat",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.shortstat", () => {
  it("returns zero counts on a clean worktree (vs base)", async () => {
    const { ws } = await makeGitWorkspace("ss-clean");
    const stat = await ws.git.shortstat("base");
    expect(stat).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("counts uncommitted modifications to tracked files (vs base)", async () => {
    const { wsPath, ws } = await makeGitWorkspace("ss-uncommitted");
    // Original: "# repo\n" → New: "# repo\n\nadded line\n" — diff is +2 lines.
    await writeUtf8(path.join(wsPath, "README.md"), "# repo\n\nadded line\n");

    const stat = await ws.git.shortstat("base");
    expect(stat.files).toBe(1);
    expect(stat.additions).toBe(2);
    expect(stat.deletions).toBe(0);
  });

  it("counts committed changes (vs base)", async () => {
    const { wsPath, ws } = await makeGitWorkspace("ss-committed");
    await writeUtf8(path.join(wsPath, "feature.ts"), "export const x = 1;\n");
    await ws.git.commit("add feature.ts");

    const stat = await ws.git.shortstat("base");
    expect(stat.files).toBe(1);
    expect(stat.additions).toBe(1);
    expect(stat.deletions).toBe(0);
  });

  it("counts committed + uncommitted together (vs base = working tree vs base)", async () => {
    const { wsPath, ws } = await makeGitWorkspace("ss-mixed");
    await writeUtf8(path.join(wsPath, "a.ts"), "export const a = 1;\n");
    await ws.git.commit("add a");
    await writeUtf8(path.join(wsPath, "a.ts"), "export const a = 1;\nexport const b = 2;\n");

    const stat = await ws.git.shortstat("base");
    expect(stat.files).toBe(1);
    expect(stat.additions).toBe(2);
  });
});
