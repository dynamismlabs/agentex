import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import { makeTmpDir, pathExists, removeTmpDir, writeUtf8 } from "./helpers.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

async function makeWorkspace(label: string) {
  const root = await makeTmpDir(label);
  tmpDirs.push(root);
  const wsPath = path.join(root, "ws");
  const ws = await workspace.create({ kind: "bare", path: wsPath });
  return { root, wsPath, ws };
}

describe("ContextDir", () => {
  it("dir always resolves to <workspace>/.context; the directory is lazy", async () => {
    const { ws } = await makeWorkspace("ctx-lazy");

    expect(ws.context.dir).toBe(path.join(ws.path, ".context"));
    expect(await pathExists(ws.context.dir)).toBe(false);
  });

  it("write creates .context/ on first call and persists content", async () => {
    const { ws } = await makeWorkspace("ctx-write");

    await ws.context.write("notes.md", "hello");

    expect(await pathExists(ws.context.dir)).toBe(true);
    expect(await fs.readFile(path.join(ws.context.dir, "notes.md"), "utf-8")).toBe("hello");
  });

  it("write supports nested paths and creates parent dirs", async () => {
    const { ws } = await makeWorkspace("ctx-write-nested");

    await ws.context.write("plans/q3/draft.md", "content");

    expect(await fs.readFile(path.join(ws.context.dir, "plans", "q3", "draft.md"), "utf-8")).toBe(
      "content",
    );
  });

  it("read returns previously written content; throws ENOENT on missing", async () => {
    const { ws } = await makeWorkspace("ctx-read");

    await ws.context.write("notes.md", "body");
    expect(await ws.context.read("notes.md")).toBe("body");

    await expect(ws.context.read("missing.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path-escape attempts", async () => {
    const { ws } = await makeWorkspace("ctx-escape");

    await expect(ws.context.write("../escaped.md", "x")).rejects.toThrow(/escapes \.context\//);
    await expect(ws.context.read("../escaped.md")).rejects.toThrow(/escapes \.context\//);
    await expect(ws.context.write("/abs/path", "x")).rejects.toThrow(/must not be absolute/);
  });

  it("attach copies into attachments/ with safe naming and collision suffixes", async () => {
    const { root, ws } = await makeWorkspace("ctx-attach");
    const src = path.join(root, "source", "photo.png");
    await writeUtf8(src, "img-bytes");

    const first = await ws.context.attach(src);
    expect(first).toBe(path.join(ws.context.dir, "attachments", "photo.png"));
    expect(await fs.readFile(first, "utf-8")).toBe("img-bytes");

    const second = await ws.context.attach(src);
    expect(second).toBe(path.join(ws.context.dir, "attachments", "photo (2).png"));

    const third = await ws.context.attach(src);
    expect(third).toBe(path.join(ws.context.dir, "attachments", "photo (3).png"));
  });

  it("attach handles files with no extension", async () => {
    const { root, ws } = await makeWorkspace("ctx-attach-noext");
    const src = path.join(root, "source", "Makefile");
    await writeUtf8(src, "default:\n");

    const first = await ws.context.attach(src);
    const second = await ws.context.attach(src);

    expect(path.basename(first)).toBe("Makefile");
    expect(path.basename(second)).toBe("Makefile (2)");
  });

  it("attach throws if the source path does not exist", async () => {
    const { root, ws } = await makeWorkspace("ctx-attach-missing");
    const missing = path.join(root, "nope.txt");

    await expect(ws.context.attach(missing)).rejects.toThrow(/source file does not exist/);
  });

  it("list returns [] when .context/ does not exist; otherwise enumerates", async () => {
    const { ws } = await makeWorkspace("ctx-list");

    expect(await ws.context.list()).toEqual([]);

    await ws.context.write("notes.md", "n");
    await ws.context.write("todos.md", "t");
    const root = await ws.context.list();
    expect(root.sort()).toEqual(["notes.md", "todos.md"]);

    expect(await ws.context.list("missing")).toEqual([]);

    await ws.context.write("plans/q3.md", "p");
    expect(await ws.context.list("plans")).toEqual(["q3.md"]);
  });
});
