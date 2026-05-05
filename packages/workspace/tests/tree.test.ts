import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import type { TreeNode } from "../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "./helpers.js";
import { setupSimpleRepo } from "./git-helpers.js";

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

function namesOf(node: TreeNode): string[] {
  return (node.children ?? []).map((c) => c.name);
}

describe("ws.tree", () => {
  it("returns a single dir node for an empty workspace", async () => {
    const root = await tmp("tree-empty");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });

    const tree = await ws.tree();
    expect(tree.kind).toBe("dir");
    expect(tree.path).toBe(wsPath);
    expect(tree.name).toBe(path.basename(wsPath));
    expect(tree.children).toEqual([]);
  });

  it("walks files and directories, sorting children alphabetically", async () => {
    const root = await tmp("tree-walk");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });

    await writeUtf8(path.join(wsPath, "z.txt"), "z");
    await writeUtf8(path.join(wsPath, "a.txt"), "a");
    await writeUtf8(path.join(wsPath, "sub", "nested.txt"), "n");
    await writeUtf8(path.join(wsPath, "sub", "deep", "leaf.txt"), "l");

    const tree = await ws.tree();
    expect(namesOf(tree)).toEqual(["a.txt", "sub", "z.txt"]);

    const sub = tree.children!.find((c) => c.name === "sub")!;
    expect(sub.kind).toBe("dir");
    expect(namesOf(sub)).toEqual(["deep", "nested.txt"]);

    const deep = sub.children!.find((c) => c.name === "deep")!;
    expect(namesOf(deep)).toEqual(["leaf.txt"]);
  });

  it("skips .git/ in git workspaces", async () => {
    const root = await tmp("tree-git-skip");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);
    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/tree",
    });

    const tree = await ws.tree();
    const names = namesOf(tree);
    expect(names).not.toContain(".git");
    expect(names).toContain("README.md");
  });

  it("file nodes have no children property", async () => {
    const root = await tmp("tree-file-shape");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });
    await writeUtf8(path.join(wsPath, "lone.txt"), "");

    const tree = await ws.tree();
    const file = tree.children!.find((c) => c.name === "lone.txt")!;
    expect(file.kind).toBe("file");
    expect(file.path).toBe(path.join(wsPath, "lone.txt"));
    expect(file.children).toBeUndefined();
  });
});
