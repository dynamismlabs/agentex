import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import { ArchiveScriptFailedError, WorkspaceNotFoundError } from "../src/index.js";
import { makeTmpDir, pathExists, readUtf8, removeTmpDir, writeUtf8 } from "./helpers.js";

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

describe("workspace.create (bare)", () => {
  it("creates a bare workspace; kind, path, source set; context dir not yet materialized", async () => {
    const root = await tmp("create-bare");
    const wsPath = path.join(root, "ws");

    const ws = await workspace.create({ kind: "bare", path: wsPath });

    expect(ws.kind).toBe("bare");
    expect(ws.path).toBe(wsPath);
    expect(ws.source).toBeUndefined();
    expect(await pathExists(wsPath)).toBe(true);
    expect(ws.context.dir).toBe(path.join(wsPath, ".context"));
    expect(await pathExists(ws.context.dir)).toBe(false);
  });

  it("records source when provided", async () => {
    const root = await tmp("create-bare-source");
    const wsPath = path.join(root, "ws");
    const sourcePath = path.join(root, "source");
    await fs.mkdir(sourcePath, { recursive: true });

    const ws = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    expect(ws.source).toBe(sourcePath);
  });

  it("rejects a relative path", async () => {
    await expect(
      workspace.create({ kind: "bare", path: "relative/path" }),
    ).rejects.toThrow(/must be an absolute path/);
  });

  it("rejects a relative source path", async () => {
    const root = await tmp("create-bare-relsource");
    await expect(
      workspace.create({ kind: "bare", path: path.join(root, "ws"), source: "rel/source" }),
    ).rejects.toThrow(/source must be an absolute path/);
  });

  it("creates parent directories (mkdir -p)", async () => {
    const root = await tmp("create-bare-mkdirp");
    const wsPath = path.join(root, "a", "b", "c", "ws");

    const ws = await workspace.create({ kind: "bare", path: wsPath });

    expect(await pathExists(ws.path)).toBe(true);
  });

  it("rejects a path that already contains a .git/ entry (consumer probably meant kind: 'git')", async () => {
    const root = await tmp("create-bare-with-git");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(path.join(wsPath, ".git"), { recursive: true });

    await expect(
      workspace.create({ kind: "bare", path: wsPath }),
    ).rejects.toThrow(/already contains a \.git\/ entry.*did you mean kind: "git"/);

    // The dir is preserved (existence check happens before any state change).
    expect(await pathExists(path.join(wsPath, ".git"))).toBe(true);
  });

  it("succeeds on a populated bare directory; preserves existing contents", async () => {
    const root = await tmp("create-bare-populated");
    const wsPath = path.join(root, "ws");
    await fs.mkdir(wsPath, { recursive: true });
    await writeUtf8(path.join(wsPath, "draft.md"), "user content");
    await fs.mkdir(path.join(wsPath, "subdir"), { recursive: true });
    await writeUtf8(path.join(wsPath, "subdir", "nested.txt"), "nested");

    const ws = await workspace.create({ kind: "bare", path: wsPath });

    expect(ws.path).toBe(wsPath);
    expect(await readUtf8(path.join(wsPath, "draft.md"))).toBe("user content");
    expect(await readUtf8(path.join(wsPath, "subdir", "nested.txt"))).toBe("nested");
    // .context not auto-created
    expect(await pathExists(ws.context.dir)).toBe(false);
  });
});

describe("workspace.open", () => {
  it("throws WorkspaceNotFoundError on missing path", async () => {
    const root = await tmp("open-missing");
    const missing = path.join(root, "nope");

    await expect(workspace.open(missing)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(workspace.open(missing)).rejects.toMatchObject({
      name: "WorkspaceNotFoundError",
      path: missing,
    });
  });

  it("rejects a relative path", async () => {
    await expect(workspace.open("rel/path")).rejects.toThrow(/must be an absolute path/);
  });

  it("returns an equivalent handle after create (path, source, context.dir match)", async () => {
    const root = await tmp("open-roundtrip");
    const wsPath = path.join(root, "ws");
    const sourcePath = path.join(root, "source");
    await fs.mkdir(sourcePath, { recursive: true });

    const created = await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });
    const reopened = await workspace.open(wsPath, { source: sourcePath });

    expect(reopened.kind).toBe("bare");
    expect(reopened.path).toBe(created.path);
    expect(reopened.source).toBe(created.source);
    expect(reopened.context.dir).toBe(created.context.dir);
  });

  it("returns source: undefined if open is called without opts.source (no marker file)", async () => {
    const root = await tmp("open-no-source");
    const wsPath = path.join(root, "ws");
    const sourcePath = path.join(root, "source");
    await fs.mkdir(sourcePath, { recursive: true });

    await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });
    const reopened = await workspace.open(wsPath);

    expect(reopened.source).toBeUndefined();
  });

  it("throws meaningfully on a malformed git path (no rev-parse-able git dir)", async () => {
    const root = await tmp("open-malformed-git");
    const wsPath = path.join(root, "ws");
    // An empty `.git/` dir looks like git but isn't initialized — git itself
    // refuses it. We surface a clear error rather than crashing or returning
    // an inconsistent handle.
    await fs.mkdir(path.join(wsPath, ".git"), { recursive: true });

    await expect(workspace.open(wsPath)).rejects.toThrow();
  });
});

describe("workspace.archive (bare)", () => {
  it("removes the workspace directory", async () => {
    const root = await tmp("archive-rm");
    const wsPath = path.join(root, "ws");
    await workspace.create({ kind: "bare", path: wsPath });
    await writeUtf8(path.join(wsPath, "scratch.md"), "stuff");

    await workspace.archive(wsPath);

    expect(await pathExists(wsPath)).toBe(false);
  });

  it("runs scripts.archive (one-shot) before removing; archive script sees AGENTEX_WORKSPACE and AGENTEX_SOURCE env", async () => {
    const root = await tmp("archive-script");
    const wsPath = path.join(root, "ws");
    const sourcePath = path.join(root, "source");
    const sentinelDir = path.join(root, "sentinel");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(sentinelDir, { recursive: true });

    await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });

    const sentinel = path.join(sentinelDir, "ran");
    const config = {
      scripts: {
        archive: `printf '%s|%s' "$AGENTEX_WORKSPACE" "$AGENTEX_SOURCE" > "${sentinel}"`,
      },
    };
    await writeUtf8(path.join(wsPath, "agentex.workspace.json"), JSON.stringify(config));

    await workspace.archive(wsPath, { source: sourcePath });

    expect(await pathExists(wsPath)).toBe(false);
    expect(await pathExists(sentinel)).toBe(true);
    const content = await readUtf8(sentinel);
    expect(content).toBe(`${wsPath}|${sourcePath}`);
  });

  it("throws ArchiveScriptFailedError when the archive script exits non-zero; workspace is not removed", async () => {
    const root = await tmp("archive-fail");
    const wsPath = path.join(root, "ws");
    await workspace.create({ kind: "bare", path: wsPath });
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({ scripts: { archive: "echo nope >&2; exit 7" } }),
    );

    await expect(workspace.archive(wsPath)).rejects.toBeInstanceOf(ArchiveScriptFailedError);
    await expect(workspace.archive(wsPath)).rejects.toMatchObject({
      name: "ArchiveScriptFailedError",
      exitCode: 7,
    });

    expect(await pathExists(wsPath)).toBe(true);
  });

  it("is a no-op when the workspace path is missing on disk (bare)", async () => {
    const root = await tmp("archive-missing");
    const missing = path.join(root, "nope");

    await workspace.archive(missing);

    expect(await pathExists(missing)).toBe(false);
  });

  it("removes the directory when no archive script is configured", async () => {
    const root = await tmp("archive-noscript");
    const wsPath = path.join(root, "ws");
    await workspace.create({ kind: "bare", path: wsPath });

    await workspace.archive(wsPath);

    expect(await pathExists(wsPath)).toBe(false);
  });

  it("on a malformed git path throws meaningfully (status check fails on a non-repo `.git/` dir)", async () => {
    const root = await tmp("archive-git-malformed");
    const wsPath = path.join(root, "ws");
    // An empty `.git/` looks git-shaped but isn't a real repo. Slice 5's
    // archive flow runs `git status` and fails; we surface a clear error
    // rather than crashing or silently doing the wrong thing.
    await fs.mkdir(path.join(wsPath, ".git"), { recursive: true });

    await expect(workspace.archive(wsPath)).rejects.toThrow();
  });
});

describe("workspace config: source-side and workspace-side merge", () => {
  it("workspace-side agentex.workspace.json overrides source-side for scripts.archive", async () => {
    const root = await tmp("config-override");
    const wsPath = path.join(root, "ws");
    const sourcePath = path.join(root, "source");
    const sentinelDir = path.join(root, "sentinel");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(sentinelDir, { recursive: true });

    const sourceSentinel = path.join(sentinelDir, "source");
    const workspaceSentinel = path.join(sentinelDir, "workspace");

    await writeUtf8(
      path.join(sourcePath, "agentex.workspace.json"),
      JSON.stringify({
        scripts: { archive: `touch "${sourceSentinel}"` },
      }),
    );

    await workspace.create({ kind: "bare", path: wsPath, source: sourcePath });
    await writeUtf8(
      path.join(wsPath, "agentex.workspace.json"),
      JSON.stringify({
        scripts: { archive: `touch "${workspaceSentinel}"` },
      }),
    );

    await workspace.archive(wsPath, { source: sourcePath });

    expect(await pathExists(sourceSentinel)).toBe(false);
    expect(await pathExists(workspaceSentinel)).toBe(true);
  });
});
