import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import {
  makeTmpDir,
  pathExists,
  readUtf8,
  removeTmpDir,
  writeUtf8,
} from "./helpers.js";
import { setupRepoWithMultipleDirs, setupSimpleRepo } from "./git-helpers.js";

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

describe("declarative fromSource auto-apply", () => {
  it("bare workspace: applies fromSource block from source-side agentex.workspace.json on create", async () => {
    const root = await tmp("decl-bare");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });

    await writeUtf8(path.join(sourcePath, "env", ".env"), "BASE=1\n");
    await writeUtf8(path.join(sourcePath, "shared", "blob.txt"), "blob");
    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({
        fromSource: {
          copy: ["env/**"],
          link: ["shared"],
        },
      }),
    );

    const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    expect(await readUtf8(path.join(wsPath, "env", ".env"))).toBe("BASE=1\n");

    const sharedStat = await fs.lstat(path.join(wsPath, "shared"));
    expect(sharedStat.isSymbolicLink()).toBe(true);
    expect(await readUtf8(path.join(wsPath, "shared", "blob.txt"))).toBe("blob");

    expect(ws.fromSourceWarnings.skippedOutsideSparse).toEqual([]);
  });

  it("git workspace: applies fromSource block from source-side agentex.workspace.json on create", async () => {
    const root = await tmp("decl-git");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupSimpleRepo(sourcePath);

    // Untracked source side files that the workspace should pick up.
    await writeUtf8(path.join(sourcePath, ".env.local"), "LOCAL=1\n");
    await writeUtf8(path.join(sourcePath, "storage", "db.sqlite"), "db");

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({
        fromSource: {
          copy: [".env.local"],
          link: ["storage"],
        },
      }),
    );

    await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/decl",
    });

    expect(await readUtf8(path.join(wsPath, ".env.local"))).toBe("LOCAL=1\n");
    const stat = await fs.lstat(path.join(wsPath, "storage"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("applyFromSource: false skips auto-apply; consumer can call manually", async () => {
    const root = await tmp("decl-optout");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });

    await writeUtf8(path.join(sourcePath, ".env"), "X=1\n");
    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({ fromSource: { copy: [".env"] } }),
    );

    const ws = await workspace.create({
      kind: "bare",
      path: wsPath,
      source: sourcePath,
      applyFromSource: false,
    });

    expect(await pathExists(path.join(wsPath, ".env"))).toBe(false);

    await ws.copyFromSource([".env"]);
    expect(await readUtf8(path.join(wsPath, ".env"))).toBe("X=1\n");
  });

  it("workspace-side fromSource block overrides source-side at create", async () => {
    const root = await tmp("decl-override");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(wsPath, { recursive: true });

    await writeUtf8(path.join(sourcePath, "src.env"), "SRC=1\n");
    await writeUtf8(path.join(sourcePath, "ws.env"), "WS=1\n");

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({ fromSource: { copy: ["src.env"] } }),
    );
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ fromSource: { copy: ["ws.env"] } }),
    );

    await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    // Workspace-side block wins; only ws.env is applied.
    expect(await pathExists(path.join(wsPath, "ws.env"))).toBe(true);
    expect(await pathExists(path.join(wsPath, "src.env"))).toBe(false);
  });

  it("sparseInclude × fromSource: skipped entries land on ws.fromSourceWarnings", async () => {
    const root = await tmp("decl-sparse");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupRepoWithMultipleDirs(sourcePath);
    await writeUtf8(path.join(sourcePath, "packages", "bar", ".env.local"), "BAR=1\n");

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({
        fromSource: {
          copy: ["packages/bar/.env.local"],
          link: ["packages/bar"],
        },
      }),
    );

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/decl-sparse",
      sparseInclude: ["packages/foo"],
    });

    expect(await pathExists(path.join(wsPath, "packages", "bar", ".env.local"))).toBe(false);
    expect(await pathExists(path.join(wsPath, "packages", "bar"))).toBe(false);
    expect(ws.fromSourceWarnings.skippedOutsideSparse).toContain("packages/bar/.env.local");
    expect(ws.fromSourceWarnings.skippedOutsideSparse).toContain("packages/bar");
  });

  it("no fromSource block in config → no auto-apply, no errors", async () => {
    const root = await tmp("decl-empty");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(sourcePath, { recursive: true });

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { setup: "true" } }),
    );

    const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    expect(ws.fromSourceWarnings.skippedOutsideSparse).toEqual([]);
  });
});
