import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_SANITIZED_LENGTH,
  canonicalizeCwd,
  findClaudeTranscriptBySessionId,
  getClaudeTranscriptPath,
  peekClaudeTranscript,
  readClaudeTranscript,
  resolveClaudeHome,
  sanitizeProjectPath,
} from "../../../src/providers/claude/transcript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentex-claude-test-"));
  await mkdir(path.join(dir, "projects"), { recursive: true });
  return dir;
}

function line(json: Record<string, unknown>): string {
  return JSON.stringify(json);
}

function jsonlOf(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

// Realistic Claude transcript lines mirroring the on-disk shape.
const SAMPLE_QUEUE_OPERATION = line({
  type: "queue-operation",
  op: "enqueue",
  uuid: "u-queue-1",
});

const SAMPLE_USER_TOOL_RESULT = line({
  type: "user",
  session_id: "sess-1",
  uuid: "u-user-1",
  message: {
    id: "msg-1",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "hello world",
        is_error: false,
      },
    ],
  },
});

const SAMPLE_ASSISTANT_TEXT_AND_TOOL = line({
  type: "assistant",
  session_id: "sess-1",
  uuid: "u-assistant-1",
  message: {
    id: "msg-2",
    content: [
      { type: "text", text: "thinking out loud" },
      { type: "tool_use", id: "call-2", name: "Bash", input: { cmd: "ls" } },
    ],
  },
});

const SAMPLE_RESULT = line({
  type: "result",
  session_id: "sess-1",
  uuid: "u-result-1",
  result: "done",
  is_error: false,
  total_cost_usd: 0.001,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  num_turns: 3,
  duration_ms: 1234,
});

// ---------------------------------------------------------------------------
// sanitizeProjectPath
// ---------------------------------------------------------------------------

describe("sanitizeProjectPath", () => {
  it("matches the on-disk encoding for typical absolute paths", () => {
    expect(sanitizeProjectPath("/Users/turing/code/widgets")).toBe("-Users-turing-code-widgets");
  });

  it("doubles a hyphen when the next segment starts with a dot", () => {
    expect(sanitizeProjectPath("/Users/foo/.config")).toBe("-Users-foo--config");
  });

  it("preserves embedded hyphens (hyphen is non-alphanumeric, replaced by hyphen — no-op)", () => {
    expect(sanitizeProjectPath("/Users/foo/flow-test")).toBe("-Users-foo-flow-test");
  });

  it("doubles when both . and - appear at a segment boundary", () => {
    expect(sanitizeProjectPath("/Users/foo/.flow-test")).toBe("-Users-foo--flow-test");
  });

  it("replaces underscore with hyphen (not preserved as the naive proposal would)", () => {
    expect(sanitizeProjectPath("/Users/foo/my_app")).toBe("-Users-foo-my-app");
  });

  it("replaces all non-alphanumeric characters", () => {
    expect(sanitizeProjectPath("/a:b c.d_e")).toBe("-a-b-c-d-e");
  });

  it("handles consecutive slashes and dots", () => {
    expect(sanitizeProjectPath("//a..b")).toBe("--a--b");
  });

  it("truncates with a hash suffix when sanitized name exceeds the cap", () => {
    const longPath = "/" + "x".repeat(MAX_SANITIZED_LENGTH + 50);
    const sanitized = sanitizeProjectPath(longPath);
    expect(sanitized.length).toBeGreaterThan(MAX_SANITIZED_LENGTH);
    expect(sanitized.length).toBeLessThanOrEqual(MAX_SANITIZED_LENGTH + 1 + 16); // prefix + "-" + hash
    expect(sanitized.startsWith("-" + "x".repeat(MAX_SANITIZED_LENGTH - 1))).toBe(true);
    // Deterministic for the same input.
    expect(sanitizeProjectPath(longPath)).toBe(sanitized);
  });

  it("matches the empirical encoding for a long, nested path with dotted segments", () => {
    const cwd =
      "/Users/turing/.tooling/instances/default/workspaces/f4b86869-6367-4082-aa0e-461938a0d4e8";
    expect(sanitizeProjectPath(cwd)).toBe(
      "-Users-turing--tooling-instances-default-workspaces-f4b86869-6367-4082-aa0e-461938a0d4e8",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeHome
// ---------------------------------------------------------------------------

describe("resolveClaudeHome", () => {
  const origEnv = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origEnv;
  });

  it("honors the explicit override", () => {
    expect(resolveClaudeHome("/tmp/explicit")).toBe("/tmp/explicit");
  });

  it("falls back to CLAUDE_CONFIG_DIR env var", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/from-env";
    expect(resolveClaudeHome()).toBe("/tmp/from-env");
  });

  it("falls back to ~/.claude when no env var set", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeHome()).toBe(path.join(os.homedir(), ".claude"));
  });
});

// ---------------------------------------------------------------------------
// canonicalizeCwd
// ---------------------------------------------------------------------------

describe("canonicalizeCwd", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "agentex-canon-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("resolves symlinks", async () => {
    const real = path.join(tmpRoot, "real");
    const link = path.join(tmpRoot, "link");
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    const canon = await canonicalizeCwd(link);
    // On macOS the tmpdir itself is a symlink (/var/folders/... → /private/var/folders/...).
    // realpath resolves both layers, so compare via realpath of `real` for stability.
    const { realpath } = await import("node:fs/promises");
    expect(canon).toBe(await realpath(real));
  });

  it("returns input (NFC) when realpath fails", async () => {
    const canon = await canonicalizeCwd("/this/path/does/not/exist/probably-very-much-not");
    expect(canon).toBe("/this/path/does/not/exist/probably-very-much-not");
  });
});

// ---------------------------------------------------------------------------
// getClaudeTranscriptPath
// ---------------------------------------------------------------------------

describe("getClaudeTranscriptPath", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTempHome();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("computes the deterministic path for a missing file", async () => {
    const res = await getClaudeTranscriptPath({
      sessionId: "abc-123",
      cwd: "/Users/test/project",
      claudeHome: home,
    });
    expect(res.filePath).toBe(path.join(home, "projects", "-Users-test-project", "abc-123.jsonl"));
    expect(res.projectDir).toBe("-Users-test-project");
    expect(res.claudeHome).toBe(home);
  });

  it("canonicalizes cwd before encoding (resolves symlink)", async () => {
    const realCwd = path.join(home, "real-project");
    const linkCwd = path.join(home, "link-project");
    await mkdir(realCwd, { recursive: true });
    await symlink(realCwd, linkCwd);

    // On macOS, the tmp root itself is symlinked (/var/folders → /private/var/folders),
    // so the realpath of even the "real" dir differs from realCwd. Resolve both for
    // an apples-to-apples comparison.
    const { realpath } = await import("node:fs/promises");
    const expectedCanonical = await realpath(realCwd);

    const res = await getClaudeTranscriptPath({
      sessionId: "sess-1",
      cwd: linkCwd,
      claudeHome: home,
    });
    expect(res.canonicalCwd).toBe(expectedCanonical);
    expect(res.projectDir).toBe(sanitizeProjectPath(expectedCanonical));
  });

  it("does prefix-scan fallback for long paths with hash mismatch", async () => {
    const longCwd = "/" + "p".repeat(MAX_SANITIZED_LENGTH + 30);
    const sanitized = sanitizeProjectPath(longCwd);
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH);
    // Simulate Claude having written under a different hash suffix:
    const onDiskDir = `${prefix}-alienhashvalue`;
    await mkdir(path.join(home, "projects", onDiskDir), { recursive: true });
    await writeFile(
      path.join(home, "projects", onDiskDir, "long-session.jsonl"),
      jsonlOf(SAMPLE_RESULT),
    );

    const res = await getClaudeTranscriptPath({
      sessionId: "long-session",
      cwd: longCwd,
      claudeHome: home,
    });
    expect(res.projectDir).toBe(onDiskDir);
    expect(res.filePath).toBe(path.join(home, "projects", onDiskDir, "long-session.jsonl"));
  });

  it("returns deterministic path when long-path scan finds no match", async () => {
    const longCwd = "/" + "q".repeat(MAX_SANITIZED_LENGTH + 30);
    const res = await getClaudeTranscriptPath({
      sessionId: "no-such-session",
      cwd: longCwd,
      claudeHome: home,
    });
    expect(res.projectDir).toBe(sanitizeProjectPath(longCwd));
  });

  it("throws if sessionId is missing", async () => {
    await expect(
      getClaudeTranscriptPath({ sessionId: "", cwd: "/x", claudeHome: home }),
    ).rejects.toThrow(/sessionId/);
  });

  it("throws if cwd is missing", async () => {
    await expect(
      getClaudeTranscriptPath({ sessionId: "s", cwd: "", claudeHome: home }),
    ).rejects.toThrow(/cwd/);
  });
});

// ---------------------------------------------------------------------------
// findClaudeTranscriptBySessionId (resume-by-id case)
// ---------------------------------------------------------------------------

// Claude's on-disk lines carry `cwd` on the outer envelope of every event,
// not via a separate `system.init` line. This mirrors the real shape:
const SAMPLE_USER_WITH_ENVELOPE = line({
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/Users/turing/code/widgets",
  sessionId: "sess-resume",
  version: "2.1.70",
  gitBranch: "main",
  type: "user",
  message: { role: "user", content: "hi" },
  uuid: "u-user-init-1",
  timestamp: "2026-05-11T00:00:00.000Z",
  permissionMode: "default",
});

describe("findClaudeTranscriptBySessionId", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTempHome();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when no transcript exists", async () => {
    const res = await findClaudeTranscriptBySessionId({
      sessionId: "missing",
      claudeHome: home,
    });
    expect(res).toBeNull();
  });

  it("finds a transcript across project dirs and extracts cwd from the envelope", async () => {
    const projectDir = "-Users-turing-code-widgets";
    const dir = path.join(home, "projects", projectDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "sess-resume.jsonl");
    await writeFile(
      filePath,
      jsonlOf(SAMPLE_QUEUE_OPERATION, SAMPLE_USER_WITH_ENVELOPE, SAMPLE_RESULT),
    );

    const res = await findClaudeTranscriptBySessionId({
      sessionId: "sess-resume",
      claudeHome: home,
    });
    expect(res).not.toBeNull();
    expect(res!.filePath).toBe(filePath);
    expect(res!.projectDir).toBe(projectDir);
    expect(res!.cwd).toBe("/Users/turing/code/widgets");
  });

  it("returns null cwd when no line carries a cwd field", async () => {
    const projectDir = "-Users-turing-code-widgets";
    const dir = path.join(home, "projects", projectDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "no-cwd.jsonl");
    // Only a `result` line which does not carry cwd on the envelope.
    await writeFile(filePath, jsonlOf(SAMPLE_RESULT));

    const res = await findClaudeTranscriptBySessionId({
      sessionId: "no-cwd",
      claudeHome: home,
    });
    expect(res).not.toBeNull();
    expect(res!.cwd).toBeNull();
  });

  it("skips empty / non-project entries under projects/", async () => {
    // Stray file at projects/ root: must not crash.
    await writeFile(path.join(home, "projects", "stray.txt"), "");
    // Wrong project dir without our session file.
    await mkdir(path.join(home, "projects", "-some-other-project"), { recursive: true });
    // The correct one.
    const projectDir = "-Users-turing-code-widgets";
    const dir = path.join(home, "projects", projectDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "sess-resume.jsonl");
    await writeFile(filePath, jsonlOf(SAMPLE_USER_WITH_ENVELOPE));

    const res = await findClaudeTranscriptBySessionId({
      sessionId: "sess-resume",
      claudeHome: home,
    });
    expect(res!.filePath).toBe(filePath);
    expect(res!.cwd).toBe("/Users/turing/code/widgets");
  });

  it("falls back to stream-style system.init events when present (forward-compat)", async () => {
    const projectDir = "-Users-turing-code-widgets";
    const dir = path.join(home, "projects", projectDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "stream-style.jsonl");
    const initLine = line({
      type: "system",
      subtype: "init",
      session_id: "stream-style",
      cwd: "/Users/turing/code/widgets",
      uuid: "u-init",
    });
    await writeFile(filePath, jsonlOf(initLine));

    const res = await findClaudeTranscriptBySessionId({
      sessionId: "stream-style",
      claudeHome: home,
    });
    expect(res!.cwd).toBe("/Users/turing/code/widgets");
  });

  it("throws when sessionId is empty", async () => {
    await expect(
      findClaudeTranscriptBySessionId({ sessionId: "", claudeHome: home }),
    ).rejects.toThrow(/sessionId/);
  });
});

// ---------------------------------------------------------------------------
// readClaudeTranscript
// ---------------------------------------------------------------------------

describe("readClaudeTranscript", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentex-read-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty iterable for a missing file", async () => {
    const out: unknown[] = [];
    for await (const e of readClaudeTranscript({
      filePath: path.join(dir, "nope.jsonl"),
    })) {
      out.push(e);
    }
    expect(out).toEqual([]);
  });

  it("yields parsed events in order, filters queue-operation, offsets increase", async () => {
    const file = path.join(dir, "happy.jsonl");
    const content = jsonlOf(
      SAMPLE_QUEUE_OPERATION,
      SAMPLE_USER_TOOL_RESULT,
      SAMPLE_ASSISTANT_TEXT_AND_TOOL,
      SAMPLE_RESULT,
    );
    await writeFile(file, content);

    const yielded: { type: string; offset: number }[] = [];
    for await (const { event, offset } of readClaudeTranscript({ filePath: file })) {
      yielded.push({ type: event.type, offset });
    }

    expect(yielded.map((y) => y.type)).toEqual([
      "tool_result", // from user
      "assistant", // text block
      "tool_call", // tool_use block (same line as assistant)
      "result",
    ]);

    // Offsets monotonically non-decreasing; the assistant+tool_call share their line's offset.
    expect(yielded[1].offset).toBe(yielded[2].offset);
    expect(yielded[0].offset).toBeLessThan(yielded[1].offset);
    expect(yielded[2].offset).toBeLessThan(yielded[3].offset);
    // Last offset equals file size (sum of lines + trailing newline per line).
    expect(yielded[3].offset).toBe(content.length);
  });

  it("skips malformed JSON lines", async () => {
    const file = path.join(dir, "malformed.jsonl");
    await writeFile(file, jsonlOf(SAMPLE_ASSISTANT_TEXT_AND_TOOL, "not-json{", SAMPLE_RESULT));

    const types: string[] = [];
    for await (const { event } of readClaudeTranscript({ filePath: file })) {
      types.push(event.type);
    }
    expect(types).toEqual(["assistant", "tool_call", "result"]);
  });

  it("resumes correctly from a previously yielded offset", async () => {
    const file = path.join(dir, "resume.jsonl");
    await writeFile(
      file,
      jsonlOf(SAMPLE_USER_TOOL_RESULT, SAMPLE_ASSISTANT_TEXT_AND_TOOL, SAMPLE_RESULT),
    );

    const first: { type: string; offset: number }[] = [];
    for await (const { event, offset } of readClaudeTranscript({ filePath: file })) {
      first.push({ type: event.type, offset });
    }

    // Resume from the offset reported after the assistant line (= after tool_call too).
    const resumeAfter = first.find((f) => f.type === "tool_call")!.offset;
    const second: string[] = [];
    for await (const { event } of readClaudeTranscript({
      filePath: file,
      fromOffset: resumeAfter,
    })) {
      second.push(event.type);
    }
    expect(second).toEqual(["result"]);
  });

  it("honors sinceEventId — drops up to and including that line", async () => {
    const file = path.join(dir, "since.jsonl");
    await writeFile(
      file,
      jsonlOf(SAMPLE_USER_TOOL_RESULT, SAMPLE_ASSISTANT_TEXT_AND_TOOL, SAMPLE_RESULT),
    );

    const out: string[] = [];
    for await (const { event } of readClaudeTranscript({
      filePath: file,
      sinceEventId: "u-assistant-1",
    })) {
      out.push(event.type);
    }
    // The assistant line had two events (assistant + tool_call). Both should be skipped.
    expect(out).toEqual(["result"]);
  });

  it("handles a file with only skipped lines", async () => {
    const file = path.join(dir, "only-skipped.jsonl");
    await writeFile(file, jsonlOf(SAMPLE_QUEUE_OPERATION, SAMPLE_QUEUE_OPERATION));
    const out: unknown[] = [];
    for await (const e of readClaudeTranscript({ filePath: file })) out.push(e);
    expect(out).toEqual([]);
  });

  it("yields nothing for an empty file (zero bytes)", async () => {
    const file = path.join(dir, "empty.jsonl");
    await writeFile(file, "");
    const out: unknown[] = [];
    for await (const e of readClaudeTranscript({ filePath: file })) out.push(e);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// peekClaudeTranscript
// ---------------------------------------------------------------------------

describe("peekClaudeTranscript", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentex-peek-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nulls for a missing file", async () => {
    const res = await peekClaudeTranscript(path.join(dir, "missing.jsonl"));
    expect(res).toEqual({ lastEvent: null, size: null });
  });

  it("returns zero size for an empty file", async () => {
    const file = path.join(dir, "empty.jsonl");
    await writeFile(file, "");
    expect(await peekClaudeTranscript(file)).toEqual({ lastEvent: null, size: 0 });
  });

  it("returns the last real event for a normal file", async () => {
    const file = path.join(dir, "ok.jsonl");
    const content = jsonlOf(SAMPLE_ASSISTANT_TEXT_AND_TOOL, SAMPLE_RESULT);
    await writeFile(file, content);
    const res = await peekClaudeTranscript(file);
    expect(res.size).toBe(content.length);
    expect(res.lastEvent?.type).toBe("result");
  });

  it("walks back past a trailing queue-operation line", async () => {
    const file = path.join(dir, "trailing.jsonl");
    await writeFile(file, jsonlOf(SAMPLE_RESULT, SAMPLE_QUEUE_OPERATION));
    const res = await peekClaudeTranscript(file);
    expect(res.lastEvent?.type).toBe("result");
  });

  it("handles a large file by reading only the tail", async () => {
    const file = path.join(dir, "big.jsonl");
    // Build a file larger than the 16KB peek window by repeating filler lines.
    const filler = line({
      type: "assistant",
      session_id: "s",
      uuid: "filler-line-uuid",
      message: { id: "m", content: [{ type: "text", text: "x".repeat(200) }] },
    });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(filler);
    lines.push(SAMPLE_RESULT); // last line we expect peek to surface
    await writeFile(file, jsonlOf(...lines));

    const res = await peekClaudeTranscript(file);
    expect(res.lastEvent?.type).toBe("result");
  });
});
