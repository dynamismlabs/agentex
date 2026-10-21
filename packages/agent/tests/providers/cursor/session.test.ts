import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCursorSession } from "../../../src/providers/cursor/session.js";

const MOCK_CURSOR = path.resolve(import.meta.dirname, "../../fixtures/mock-cursor.sh");

describe("Cursor exec-backed session", () => {
  it("uses the promoted Cursor session id on the second send", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentex-cursor-session-"));
    const argsFile = path.join(dir, "args.jsonl");
    const session = await createCursorSession({
      cwd: dir,
      env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: argsFile },
      config: { command: MOCK_CURSOR },
    });
    await (await session.send("first")).result;
    await (await session.send("second")).result;
    const args = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(args).toHaveLength(2);
    expect(args[0]).not.toContain("--resume");
    expect(args[1]).toEqual(expect.arrayContaining(["--resume", "mock-cursor-sess-1"]));
    await session.close();
  });
});

describe("Cursor session skills", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "agentex-cursor-home-"));
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const exists = (p: string) => access(p).then(() => true, () => false);

  it("keeps one plugin folder across turns, copies skills in fresh each turn, and removes it on close", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentex-cursor-session-"));
    const alpha = path.join(dir, "alpha");
    await mkdir(alpha);
    await writeFile(path.join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: first\n---\n");
    const legacy = path.join(home, ".cursor", "skills");
    await mkdir(legacy, { recursive: true });
    await symlink(alpha, path.join(legacy, "alpha"), "dir");
    const argsFile = path.join(dir, "args.jsonl");
    const pluginsFile = path.join(dir, "plugins.jsonl");

    const session = await createCursorSession({
      cwd: dir,
      env: { MOCK_BEHAVIOR: "success", MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_PLUGIN_SKILLS_TO: pluginsFile },
      config: { command: MOCK_CURSOR, skillDirs: [alpha] },
    });
    expect(await readdir(legacy)).toEqual([]);
    await (await session.send("first")).result;
    // Edited between turns: the next turn sees the edit.
    await writeFile(path.join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: second\n---\n");
    await (await session.send("second")).result;

    const args = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const pluginDirs = args.map((a) => a[a.indexOf("--plugin-dir") + 1]);
    expect(pluginDirs[0]).toBe(pluginDirs[1]);
    const plugins = (await readFile(pluginsFile, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Array<{ skills: Array<{ skill: string }> }>);
    expect(plugins[0]![0]!.skills[0]!.skill).toContain("description: first");
    expect(plugins[1]![0]!.skills[0]!.skill).toContain("description: second");

    expect(await exists(pluginDirs[0]!)).toBe(true);
    await session.close();
    expect(await exists(pluginDirs[0]!)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
