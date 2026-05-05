import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "../helpers.js";
import { commitFile, git, setupSimpleRepo } from "../git-helpers.js";

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
  // A second commit so we have multiple files to delete/modify in tests.
  await commitFile(sourcePath, "tracked.ts", "export const a = 1;\nexport const b = 2;\n", "add tracked.ts");
  const ws = await workspace.create({
    kind: "git",
    source: sourcePath,
    baseBranch: "main",
    path: wsPath,
    branch: "feature/diff",
  });
  if (ws.kind !== "git") throw new Error("expected git workspace");
  return { root, sourcePath, wsPath, ws };
}

describe("ws.git.diff", () => {
  it("returns empty files on a clean workspace (vs base)", async () => {
    const { ws } = await makeGitWorkspace("diff-clean");
    const diff = await ws.git.diff("base");
    expect(diff.files).toEqual([]);
  });

  it("modified tracked file: one entry with status 'modified' and a hunk reflecting the change", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-modified");
    await writeUtf8(path.join(wsPath, "tracked.ts"), "export const a = 99;\nexport const b = 2;\n");

    const diff = await ws.git.diff("base");

    expect(diff.files).toHaveLength(1);
    const f = diff.files[0]!;
    expect(f.path).toBe("tracked.ts");
    expect(f.status).toBe("modified");
    expect(f.hunks.length).toBeGreaterThan(0);

    const flatLines = f.hunks.flatMap((h) => h.lines);
    expect(flatLines.some((l) => l.kind === "del" && l.text === "export const a = 1;")).toBe(true);
    expect(flatLines.some((l) => l.kind === "add" && l.text === "export const a = 99;")).toBe(true);
  });

  it("untracked file: one synthetic entry with status 'added' and an all-add hunk", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-untracked");
    await writeUtf8(path.join(wsPath, "new.ts"), "line 1\nline 2\n");

    const diff = await ws.git.diff("base");

    const newEntry = diff.files.find((f) => f.path === "new.ts");
    expect(newEntry).toBeDefined();
    expect(newEntry!.status).toBe("added");
    expect(newEntry!.hunks).toHaveLength(1);
    const hunk = newEntry!.hunks[0]!;
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(2);
    expect(hunk.lines).toEqual([
      { kind: "add", text: "line 1" },
      { kind: "add", text: "line 2" },
    ]);
  });

  it("staged-but-not-committed new file shows up via tracked-diff machinery, not the untracked synthetic path", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-staged-new");
    await writeUtf8(path.join(wsPath, "staged.ts"), "x\n");
    await git(wsPath, "add", "staged.ts");

    const diff = await ws.git.diff("base");
    const entry = diff.files.find((f) => f.path === "staged.ts");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("added");
  });

  it("deleted tracked file: status 'deleted', path is the original path", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-deleted");
    await fs.unlink(path.join(wsPath, "tracked.ts"));

    const diff = await ws.git.diff("base");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.status).toBe("deleted");
    expect(diff.files[0]!.path).toBe("tracked.ts");
  });

  it("renamed file: status 'renamed' with oldPath populated", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-renamed");
    await git(wsPath, "mv", "tracked.ts", "renamed.ts");
    await ws.git.commit("rename");

    const diff = await ws.git.diff("base");
    const entry = diff.files.find((f) => f.status === "renamed");
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("renamed.ts");
    expect(entry!.oldPath).toBe("tracked.ts");
  });

  it("multiple files of mixed types in one diff", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-mixed");
    await writeUtf8(path.join(wsPath, "tracked.ts"), "export const a = 1;\n"); // modified (1 line removed)
    await writeUtf8(path.join(wsPath, "new1.txt"), "n1\n"); // untracked
    await writeUtf8(path.join(wsPath, "new2.txt"), "n2\n"); // untracked

    const diff = await ws.git.diff("base");
    const paths = diff.files.map((f) => f.path).sort();
    expect(paths).toEqual(["new1.txt", "new2.txt", "tracked.ts"]);
  });

  it("untracked binary file is reported with status 'added' and no hunks", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-binary");
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await fs.writeFile(path.join(wsPath, "blob.bin"), buf);

    const diff = await ws.git.diff("base");
    const entry = diff.files.find((f) => f.path === "blob.bin");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("added");
    expect(entry!.hunks).toEqual([]);
  });

  it("handles paths with spaces (git emits a quoted form in the diff header)", async () => {
    // Pre-commit the spaced-name file in source so it's part of base; then
    // modify it in the worktree so the diff is `modified`, not `added`.
    const { initRepo, commitFile } = await import("../git-helpers.js");
    const root = await tmp("diff-spaced-paths");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await initRepo(sourcePath);
    await commitFile(sourcePath, "spaced name.ts", "first\nsecond\n", "add spaced");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/spaces",
    });
    if (ws.kind !== "git") throw new Error("expected git workspace");

    await writeUtf8(path.join(wsPath, "spaced name.ts"), "first\nsecond\nthird\n");

    const diff = await ws.git.diff("base");
    const entry = diff.files.find((f) => f.path === "spaced name.ts");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("modified");
    const flat = entry!.hunks.flatMap((h) => h.lines);
    expect(flat.some((l) => l.kind === "add" && l.text === "third")).toBe(true);
  });

  it("vs checkpoint: diff between current state and a snapshot", async () => {
    const { wsPath, ws } = await makeGitWorkspace("diff-checkpoint");
    await writeUtf8(path.join(wsPath, "tracked.ts"), "v1\n");
    await ws.git.commit("checkpoint state");

    await ws.git.checkpoint("snap");

    await writeUtf8(path.join(wsPath, "tracked.ts"), "v2\n");
    await ws.git.commit("after snap");

    const diff = await ws.git.diff({ checkpoint: "snap" });
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.path).toBe("tracked.ts");
    const lines = diff.files[0]!.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.kind === "del" && l.text === "v1")).toBe(true);
    expect(lines.some((l) => l.kind === "add" && l.text === "v2")).toBe(true);
  });
});
