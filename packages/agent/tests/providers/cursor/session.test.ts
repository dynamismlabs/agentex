import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
