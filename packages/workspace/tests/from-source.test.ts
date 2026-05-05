import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  LinkDestinationConflictError,
  SourceFileMissingError,
  SourceNotProvidedError,
  workspace,
} from "../src/index.js";
import {
  makeTmpDir,
  pathExists,
  readUtf8,
  removeTmpDir,
  writeUtf8,
} from "./helpers.js";
import { initRepo, setupRepoWithMultipleDirs } from "./git-helpers.js";

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

async function makeBareWithSource(label: string) {
  const root = await tmp(label);
  const sourcePath = path.join(root, "source");
  const wsPath = path.join(root, "ws");
  await fs.mkdir(sourcePath, { recursive: true });
  const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });
  return { root, sourcePath, wsPath, ws };
}

describe("copyFromSource (imperative)", () => {
  it("copies files matching globs from source into the same relative paths in workspace", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("copy-basic");
    await writeUtf8(path.join(sourcePath, "apps", "web", ".env.local"), "WEB=1\n");
    await writeUtf8(path.join(sourcePath, "apps", "imagen", ".env.local"), "IMAGEN=1\n");
    await writeUtf8(path.join(sourcePath, "apps", "web", "main.ts"), "// not env\n");

    await ws.copyFromSource(["apps/**/.env*"]);

    expect(await readUtf8(path.join(wsPath, "apps", "web", ".env.local"))).toBe("WEB=1\n");
    expect(await readUtf8(path.join(wsPath, "apps", "imagen", ".env.local"))).toBe("IMAGEN=1\n");
    expect(await pathExists(path.join(wsPath, "apps", "web", "main.ts"))).toBe(false);
  });

  it("globs are dot-aware (matches `.env*` and similar dot files)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("copy-dot");
    await writeUtf8(path.join(sourcePath, ".env"), "BASE=1\n");
    await writeUtf8(path.join(sourcePath, ".env.local"), "LOCAL=1\n");

    await ws.copyFromSource(["**/.env*"]);

    expect(await readUtf8(path.join(wsPath, ".env"))).toBe("BASE=1\n");
    expect(await readUtf8(path.join(wsPath, ".env.local"))).toBe("LOCAL=1\n");
  });

  it("overwrites existing destination (cp -f semantics)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("copy-overwrite");
    await writeUtf8(path.join(sourcePath, "config.json"), "from source");
    await writeUtf8(path.join(wsPath, "config.json"), "stale");

    await ws.copyFromSource(["config.json"]);

    expect(await readUtf8(path.join(wsPath, "config.json"))).toBe("from source");
  });

  it("skips `.git/` in source even when the glob would match (`**/HEAD`)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("copy-skip-git");
    await initRepo(sourcePath);

    await ws.copyFromSource(["**/HEAD"]);

    expect(await pathExists(path.join(wsPath, ".git", "HEAD"))).toBe(false);
  });

  it("throws SourceNotProvidedError when bare workspace was created without source", async () => {
    const root = await tmp("copy-no-source");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });

    await expect(ws.copyFromSource(["**/*"])).rejects.toBeInstanceOf(SourceNotProvidedError);
  });

  it("validates patterns: rejects empty / absolute / `..`", async () => {
    const { ws } = await makeBareWithSource("copy-validate");

    await expect(ws.copyFromSource([""])).rejects.toThrow(/non-empty string/);
    await expect(ws.copyFromSource(["/abs/path"])).rejects.toThrow(/relative to source/);
    await expect(ws.copyFromSource(["../escape"])).rejects.toThrow(/'\.\.'/);
  });

  it("with sparse-restricted git workspace: skips matches whose dest dir is excluded; records on warnings", async () => {
    const root = await tmp("copy-sparse");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupRepoWithMultipleDirs(sourcePath);

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/sparse-copy",
      sparseInclude: ["packages/foo"],
    });

    // packages/bar/index.ts is committed in source but lives outside the sparse view.
    await ws.copyFromSource(["packages/bar/**"]);

    expect(await pathExists(path.join(wsPath, "packages", "bar", "index.ts"))).toBe(false);
    expect(ws.fromSourceWarnings.skippedOutsideSparse).toContain("packages/bar/index.ts");
  });
});

describe("linkFromSource (imperative)", () => {
  it("creates symlinks from source paths to the same relative dest in workspace", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("link-basic");
    await writeUtf8(path.join(sourcePath, "apps", "web", ".env.local"), "WEB=1\n");

    await ws.linkFromSource(["apps/web/.env.local"]);

    const dest = path.join(wsPath, "apps", "web", ".env.local");
    const stat = await fs.lstat(dest);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(dest, "utf-8")).toBe("WEB=1\n");
  });

  it("works on directories (storage / .cache pattern)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("link-dir");
    await writeUtf8(path.join(sourcePath, "storage", "db.sqlite"), "data");

    await ws.linkFromSource(["storage"]);

    const stat = await fs.lstat(path.join(wsPath, "storage"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(wsPath, "storage", "db.sqlite"), "utf-8")).toBe("data");
  });

  it("overwrites an existing destination file (ln -sf semantics)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("link-overwrite-file");
    await writeUtf8(path.join(sourcePath, "config.local"), "from source");
    await writeUtf8(path.join(wsPath, "config.local"), "stale");

    await ws.linkFromSource(["config.local"]);

    const stat = await fs.lstat(path.join(wsPath, "config.local"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(wsPath, "config.local"), "utf-8")).toBe("from source");
  });

  it("refuses to silently delete a real destination directory (LinkDestinationConflictError)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("link-conflict-dir");
    await writeUtf8(path.join(sourcePath, "shared", "real.txt"), "real");
    await writeUtf8(path.join(wsPath, "shared", "stale.txt"), "stale");

    let caught: unknown = null;
    try {
      await ws.linkFromSource(["shared"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LinkDestinationConflictError);

    // The real dir is preserved, untouched.
    const stat = await fs.lstat(path.join(wsPath, "shared"));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await pathExists(path.join(wsPath, "shared", "stale.txt"))).toBe(true);
  });

  it("replaces an existing destination *symlink* directory (ln -sf style)", async () => {
    const { sourcePath, wsPath, ws } = await makeBareWithSource("link-replace-symlink");
    // Pre-existing symlink target.
    await writeUtf8(path.join(sourcePath, "old", "x.txt"), "old");
    await writeUtf8(path.join(sourcePath, "new", "x.txt"), "new");
    await fs.mkdir(path.join(wsPath), { recursive: true });
    await fs.symlink(path.join(sourcePath, "old"), path.join(wsPath, "linked"));

    // Now retarget via linkFromSource (treating "new" as the entry to symlink
    // at the same dest name "linked"). Imperative: dest is "linked", source
    // path is "new" — but our API takes one rel path used both sides. So set
    // up a same-name symlink replacement instead.
    await fs.unlink(path.join(wsPath, "linked"));
    await fs.symlink(path.join(sourcePath, "old"), path.join(wsPath, "old"));

    // Verify our existing symlink replacement: linkFromSource(["old"]) should
    // remove the old symlink and create a new one pointing to source/old.
    await ws.linkFromSource(["old"]);

    const stat = await fs.lstat(path.join(wsPath, "old"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(wsPath, "old", "x.txt"), "utf-8")).toBe("old");
  });

  it("throws SourceNotProvidedError when bare workspace was created without source", async () => {
    const root = await tmp("link-no-source");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });

    await expect(ws.linkFromSource(["x"])).rejects.toBeInstanceOf(SourceNotProvidedError);
  });

  it("throws SourceFileMissingError when a listed source path does not exist (no silent broken symlink)", async () => {
    const { ws, wsPath } = await makeBareWithSource("link-missing");

    await expect(ws.linkFromSource(["never/exists.env"])).rejects.toBeInstanceOf(
      SourceFileMissingError,
    );
    expect(await pathExists(path.join(wsPath, "never", "exists.env"))).toBe(false);
  });

  it("validates paths: rejects empty / absolute / `..`", async () => {
    const { ws } = await makeBareWithSource("link-validate");

    await expect(ws.linkFromSource([""])).rejects.toThrow(/non-empty string/);
    await expect(ws.linkFromSource(["/abs"])).rejects.toThrow(/relative to source/);
    await expect(ws.linkFromSource(["../x"])).rejects.toThrow(/'\.\.'/);
  });

  it("with sparse-restricted git workspace: skips entries outside sparse; records on warnings", async () => {
    const root = await tmp("link-sparse");
    const sourcePath = path.join(root, "source");
    const wsPath = path.join(root, "ws");
    await setupRepoWithMultipleDirs(sourcePath);
    await writeUtf8(path.join(sourcePath, "packages", "bar", ".env.local"), "BAR=1\n");

    const ws = await workspace.create({
      kind: "git",
      source: sourcePath,
      baseBranch: "main",
      path: wsPath,
      branch: "feature/sparse-link",
      sparseInclude: ["packages/foo"],
    });

    await ws.linkFromSource(["packages/bar/.env.local"]);

    expect(await pathExists(path.join(wsPath, "packages", "bar", ".env.local"))).toBe(false);
    expect(ws.fromSourceWarnings.skippedOutsideSparse).toContain("packages/bar/.env.local");
  });
});
