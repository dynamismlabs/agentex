import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TreeNode } from "./types.js";

const ALWAYS_SKIP = new Set([".git"]);

async function walkNode(absPath: string, name: string): Promise<TreeNode | null> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(absPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch {
      return { name, path: absPath, kind: "dir", children: [] };
    }
    const children: TreeNode[] = [];
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const childPath = path.join(absPath, entry.name);
      const child = await walkNode(childPath, entry.name);
      if (child !== null) children.push(child);
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    return { name, path: absPath, kind: "dir", children };
  }

  // Files and symlinks (which we surface as files).
  return { name, path: absPath, kind: "file" };
}

export async function readTree(rootPath: string): Promise<TreeNode> {
  const node = await walkNode(rootPath, path.basename(rootPath));
  if (node === null) {
    throw new Error(`tree: workspace path does not exist (${rootPath})`);
  }
  return node;
}
