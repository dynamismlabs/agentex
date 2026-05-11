import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getProvider } from "../../src/registry.js";

// The facade exists for runtime-dispatched recovery flows where the consumer
// only learns the provider type after reading a session record. These tests
// drive both facades through the same code path to verify the contract holds.

const env = process.env;

function lineOf(json: Record<string, unknown>): string {
  return JSON.stringify(json);
}

async function makeClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "facade-claude-"));
  await mkdir(path.join(dir, "projects"), { recursive: true });
  return dir;
}

async function makeCodexHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "facade-codex-"));
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

const CLAUDE_USER_ENVELOPE = lineOf({
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/Users/turing/widgets",
  sessionId: "facade-claude-sess",
  type: "user",
  message: { role: "user", content: "hi" },
  uuid: "u-1",
  timestamp: "2026-05-11T00:00:00.000Z",
});
const CLAUDE_RESULT = lineOf({
  type: "result",
  session_id: "facade-claude-sess",
  uuid: "u-2",
  result: "done",
  is_error: false,
});

const CODEX_SESSION_META = lineOf({
  timestamp: "2026-05-11T00:00:00.000Z",
  type: "session_meta",
  payload: { id: "facade-codex-sess", cwd: "/Users/turing/widgets" },
});
const CODEX_RESPONSE = lineOf({
  timestamp: "2026-05-11T00:00:01.000Z",
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
});

describe("provider.transcript (polymorphic facade)", () => {
  describe("claudeProvider.transcript", () => {
    let home: string;
    beforeEach(async () => {
      home = await makeClaudeHome();
      process.env.CLAUDE_CONFIG_DIR = home;
    });
    afterEach(async () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      if (env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
      await rm(home, { recursive: true, force: true });
    });

    it("find returns null when no transcript exists", async () => {
      const provider = getProvider("claude");
      const res = await provider.transcript!.find({
        sessionId: "facade-claude-sess",
        cwd: "/Users/turing/widgets",
      });
      expect(res).toBeNull();
    });

    it("find uses the cwd hint for an O(1) lookup when the file exists", async () => {
      const projectDir = "-Users-turing-widgets";
      const dir = path.join(home, "projects", projectDir);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "facade-claude-sess.jsonl");
      await writeFile(filePath, [CLAUDE_USER_ENVELOPE, CLAUDE_RESULT].join("\n") + "\n");

      const provider = getProvider("claude");
      const res = await provider.transcript!.find({
        sessionId: "facade-claude-sess",
        cwd: "/Users/turing/widgets",
      });
      expect(res).not.toBeNull();
      expect(res!.filePath).toBe(filePath);
      // cwd from `find` for Claude = canonicalCwd (the path actually used to compute
      // the directory). For a non-existent dir realpath falls through to NFC of input.
      expect(res!.cwd).toBe("/Users/turing/widgets");
    });

    it("find falls back to scan when the cwd hint is wrong", async () => {
      // Write the transcript under a DIFFERENT cwd than the caller will hint.
      const realProjectDir = "-Users-turing-actual-cwd";
      const dir = path.join(home, "projects", realProjectDir);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "facade-claude-sess.jsonl");
      await writeFile(
        filePath,
        lineOf({
          ...JSON.parse(CLAUDE_USER_ENVELOPE),
          cwd: "/Users/turing/actual-cwd",
        }) + "\n",
      );

      const provider = getProvider("claude");
      const res = await provider.transcript!.find({
        sessionId: "facade-claude-sess",
        cwd: "/Users/turing/widgets", // wrong hint
      });
      expect(res!.filePath).toBe(filePath);
      expect(res!.cwd).toBe("/Users/turing/actual-cwd");
    });

    it("find works without a cwd hint (pure scan)", async () => {
      const projectDir = "-Users-turing-widgets";
      const dir = path.join(home, "projects", projectDir);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "facade-claude-sess.jsonl");
      await writeFile(filePath, CLAUDE_USER_ENVELOPE + "\n");

      const provider = getProvider("claude");
      const res = await provider.transcript!.find({ sessionId: "facade-claude-sess" });
      expect(res!.filePath).toBe(filePath);
      expect(res!.cwd).toBe("/Users/turing/widgets");
    });

    it("read yields {event, offset} with StreamEvent shape", async () => {
      const projectDir = "-Users-turing-widgets";
      const dir = path.join(home, "projects", projectDir);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "facade-claude-sess.jsonl");
      await writeFile(filePath, [CLAUDE_USER_ENVELOPE, CLAUDE_RESULT].join("\n") + "\n");

      const provider = getProvider("claude");
      const types: string[] = [];
      for await (const { event, offset } of provider.transcript!.read({ filePath })) {
        expect(typeof offset).toBe("number");
        types.push((event as { type: string }).type);
      }
      expect(types).toContain("result");
    });

    it("peek returns {lastEvent, size}", async () => {
      const projectDir = "-Users-turing-widgets";
      const dir = path.join(home, "projects", projectDir);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "facade-claude-sess.jsonl");
      const content = [CLAUDE_USER_ENVELOPE, CLAUDE_RESULT].join("\n") + "\n";
      await writeFile(filePath, content);

      const provider = getProvider("claude");
      const res = await provider.transcript!.peek(filePath);
      expect(res.size).toBe(content.length);
      expect((res.lastEvent as { type: string } | null)?.type).toBe("result");
    });
  });

  describe("codexProvider.transcript", () => {
    let home: string;
    beforeEach(async () => {
      home = await makeCodexHome();
      process.env.CODEX_HOME = home;
    });
    afterEach(async () => {
      delete process.env.CODEX_HOME;
      if (env.CODEX_HOME) process.env.CODEX_HOME = env.CODEX_HOME;
      await rm(home, { recursive: true, force: true });
    });

    it("find returns null when no rollout exists", async () => {
      const provider = getProvider("codex");
      const res = await provider.transcript!.find({ sessionId: "nonexistent" });
      expect(res).toBeNull();
    });

    it("find locates a rollout by sessionId and recovers cwd", async () => {
      const dateDir = path.join(home, "sessions", "2026", "05", "11");
      await mkdir(dateDir, { recursive: true });
      const filePath = path.join(
        dateDir,
        "rollout-2026-05-11T00-00-00-facade-codex-sess.jsonl",
      );
      await writeFile(filePath, [CODEX_SESSION_META, CODEX_RESPONSE].join("\n") + "\n");

      const provider = getProvider("codex");
      const res = await provider.transcript!.find({ sessionId: "facade-codex-sess" });
      expect(res!.filePath).toBe(filePath);
      expect(res!.cwd).toBe("/Users/turing/widgets");
    });

    it("find ignores the cwd hint (codex isn't cwd-keyed)", async () => {
      const dateDir = path.join(home, "sessions", "2026", "05", "11");
      await mkdir(dateDir, { recursive: true });
      const filePath = path.join(
        dateDir,
        "rollout-2026-05-11T00-00-00-facade-codex-sess.jsonl",
      );
      await writeFile(filePath, CODEX_SESSION_META + "\n");

      const provider = getProvider("codex");
      const withHint = await provider.transcript!.find({
        sessionId: "facade-codex-sess",
        cwd: "/totally/different/path", // ignored
      });
      expect(withHint!.filePath).toBe(filePath);
    });

    it("read yields {event, offset} with CodexTranscriptLine shape", async () => {
      const dateDir = path.join(home, "sessions", "2026", "05", "11");
      await mkdir(dateDir, { recursive: true });
      const filePath = path.join(
        dateDir,
        "rollout-2026-05-11T00-00-00-facade-codex-sess.jsonl",
      );
      await writeFile(filePath, [CODEX_SESSION_META, CODEX_RESPONSE].join("\n") + "\n");

      const provider = getProvider("codex");
      const types: (string | null)[] = [];
      for await (const { event, offset } of provider.transcript!.read({ filePath })) {
        expect(typeof offset).toBe("number");
        types.push((event as { type: string | null }).type);
      }
      expect(types).toEqual(["session_meta", "response_item"]);
    });

    it("peek returns {lastEvent, size}", async () => {
      const dateDir = path.join(home, "sessions", "2026", "05", "11");
      await mkdir(dateDir, { recursive: true });
      const filePath = path.join(
        dateDir,
        "rollout-2026-05-11T00-00-00-facade-codex-sess.jsonl",
      );
      const content = [CODEX_SESSION_META, CODEX_RESPONSE].join("\n") + "\n";
      await writeFile(filePath, content);

      const provider = getProvider("codex");
      const res = await provider.transcript!.peek(filePath);
      expect(res.size).toBe(content.length);
      expect((res.lastEvent as { type: string | null } | null)?.type).toBe("response_item");
    });
  });

  it("works in a polymorphic call site that branches only on the provider name", async () => {
    // Simulates how the consuming Next.js app would use it: pull a row from
    // SQLite, dispatch through getProvider, never hit a switch.
    const claudeHome = await makeClaudeHome();
    const codexHome = await makeCodexHome();
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = codexHome;
    try {
      // Set up both fixtures.
      const claudeDir = path.join(claudeHome, "projects", "-Users-turing-widgets");
      await mkdir(claudeDir, { recursive: true });
      const claudeFile = path.join(claudeDir, "facade-claude-sess.jsonl");
      await writeFile(claudeFile, CLAUDE_USER_ENVELOPE + "\n");

      const codexDateDir = path.join(codexHome, "sessions", "2026", "05", "11");
      await mkdir(codexDateDir, { recursive: true });
      const codexFile = path.join(
        codexDateDir,
        "rollout-2026-05-11T00-00-00-facade-codex-sess.jsonl",
      );
      await writeFile(codexFile, CODEX_SESSION_META + "\n");

      const rows = [
        { provider: "claude" as const, sessionId: "facade-claude-sess", cwd: "/Users/turing/widgets" },
        { provider: "codex" as const, sessionId: "facade-codex-sess", cwd: "/anywhere" },
      ];

      const results: { provider: string; filePath: string }[] = [];
      for (const row of rows) {
        const provider = getProvider(row.provider);
        const info = await provider.transcript!.find({
          sessionId: row.sessionId,
          cwd: row.cwd,
        });
        if (info) results.push({ provider: row.provider, filePath: info.filePath });
      }

      expect(results).toEqual([
        { provider: "claude", filePath: claudeFile },
        { provider: "codex", filePath: codexFile },
      ]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      await rm(claudeHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
