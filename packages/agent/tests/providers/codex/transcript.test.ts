import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  getCodexTranscriptPath,
  parseCodexLine,
  peekCodexTranscript,
  readCodexCwd,
  readCodexTranscript,
  resolveCodexHome,
} from "../../../src/providers/codex/transcript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempCodexHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentex-codex-test-"));
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  await mkdir(path.join(dir, "archived_sessions"), { recursive: true });
  return dir;
}

async function placeRollout(
  home: string,
  args: { year: string; month: string; day: string; ts: string; sessionId: string; lines?: string[] },
): Promise<string> {
  const dir = path.join(home, "sessions", args.year, args.month, args.day);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${args.ts}-${args.sessionId}.jsonl`);
  await writeFile(filePath, (args.lines ?? []).join("\n") + (args.lines?.length ? "\n" : ""));
  return filePath;
}

const line = (json: Record<string, unknown>) => JSON.stringify(json);
const SESSION_META_LINE = line({
  timestamp: "2026-05-08T22:01:59.239Z",
  type: "session_meta",
  payload: {
    id: "11111111-2222-3333-4444-555555555555",
    cwd: "/Users/turing/test",
    originator: "codex_exec",
    cli_version: "0.128.0",
  },
});
const EVENT_MSG_LINE = line({
  timestamp: "2026-05-08T22:01:59.240Z",
  type: "event_msg",
  payload: { type: "task_started", turn_id: "t-1" },
});
const RESPONSE_ITEM_LINE = line({
  timestamp: "2026-05-08T22:01:59.250Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "ok" }],
  },
});
const UNWRAPPED_LEGACY_FIRST = line({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  timestamp: "2025-10-29T14:34:12.586Z",
  instructions: null,
});
const UNWRAPPED_LEGACY_MESSAGE = line({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "hi" }],
});

// ---------------------------------------------------------------------------
// resolveCodexHome
// ---------------------------------------------------------------------------

describe("resolveCodexHome", () => {
  const origEnv = process.env.CODEX_HOME;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
  });

  it("honors explicit override", () => {
    expect(resolveCodexHome("/tmp/explicit")).toBe("/tmp/explicit");
  });

  it("falls back to CODEX_HOME env", () => {
    process.env.CODEX_HOME = "/tmp/from-env";
    expect(resolveCodexHome()).toBe("/tmp/from-env");
  });

  it("falls back to ~/.codex when no env var set", () => {
    delete process.env.CODEX_HOME;
    expect(resolveCodexHome()).toBe(path.join(os.homedir(), ".codex"));
  });
});

// ---------------------------------------------------------------------------
// getCodexTranscriptPath
// ---------------------------------------------------------------------------

describe("getCodexTranscriptPath", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTempCodexHome();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when no session matches", async () => {
    const res = await getCodexTranscriptPath({
      sessionId: "missing-id",
      codexHome: home,
    });
    expect(res).toBeNull();
  });

  it("finds a rollout in the date tree", async () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const filePath = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T15-57-29",
      sessionId,
    });
    const res = await getCodexTranscriptPath({ sessionId, codexHome: home });
    expect(res).not.toBeNull();
    expect(res!.filePath).toBe(filePath);
    expect(res!.source).toBe("active");
    expect(res!.codexHome).toBe(home);
  });

  it("prefers active over archived when both exist", async () => {
    const sessionId = "shared-id-active";
    const activeFile = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T15-57-29",
      sessionId,
    });
    const archivedFile = path.join(
      home,
      "archived_sessions",
      `rollout-2026-05-08T15-57-29-${sessionId}.jsonl`,
    );
    await writeFile(archivedFile, "");

    const res = await getCodexTranscriptPath({ sessionId, codexHome: home });
    expect(res!.filePath).toBe(activeFile);
    expect(res!.source).toBe("active");
  });

  it("finds a rollout in archived_sessions when active is missing", async () => {
    const sessionId = "archived-only";
    const archivedFile = path.join(
      home,
      "archived_sessions",
      `rollout-2026-02-16T06-40-41-${sessionId}.jsonl`,
    );
    await writeFile(archivedFile, "");

    const res = await getCodexTranscriptPath({ sessionId, codexHome: home });
    expect(res!.filePath).toBe(archivedFile);
    expect(res!.source).toBe("archived");
  });

  it("skips archived when searchArchived: false", async () => {
    const sessionId = "archived-only-2";
    const archivedFile = path.join(
      home,
      "archived_sessions",
      `rollout-2026-02-16T06-40-41-${sessionId}.jsonl`,
    );
    await writeFile(archivedFile, "");

    const res = await getCodexTranscriptPath({
      sessionId,
      codexHome: home,
      searchArchived: false,
    });
    expect(res).toBeNull();
  });

  it("scans newest-first in the date tree", async () => {
    // Put two rollouts with the SAME session id (shouldn't happen normally, but
    // verifies traversal order: newest year/month/day visited first).
    const sessionId = "same-id-multi-date";
    await placeRollout(home, {
      year: "2024",
      month: "01",
      day: "01",
      ts: "2024-01-01T00-00-00",
      sessionId,
    });
    const newer = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T00-00-00",
      sessionId,
    });
    const res = await getCodexTranscriptPath({ sessionId, codexHome: home });
    expect(res!.filePath).toBe(newer);
  });

  it("throws when sessionId is missing", async () => {
    await expect(getCodexTranscriptPath({ sessionId: "", codexHome: home })).rejects.toThrow(
      /sessionId/,
    );
  });

  it("ignores non-date directories at the year/month/day level", async () => {
    // Put a stray non-numeric directory next to the date tree; ensure it doesn't crash.
    await mkdir(path.join(home, "sessions", "garbage-dir"), { recursive: true });
    const sessionId = "ignore-noise";
    const filePath = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T00-00-00",
      sessionId,
    });
    const res = await getCodexTranscriptPath({ sessionId, codexHome: home });
    expect(res!.filePath).toBe(filePath);
  });
});

// ---------------------------------------------------------------------------
// parseCodexLine
// ---------------------------------------------------------------------------

describe("parseCodexLine", () => {
  it("normalizes a wrapped event_msg line", () => {
    const parsed = parseCodexLine(EVENT_MSG_LINE);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("event_msg");
    expect(parsed!.timestamp).toBe("2026-05-08T22:01:59.240Z");
    expect(parsed!.payload).toMatchObject({ type: "task_started", turn_id: "t-1" });
  });

  it("normalizes an unwrapped legacy message line", () => {
    const parsed = parseCodexLine(UNWRAPPED_LEGACY_MESSAGE);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("message"); // outer type IS the line's own type
    expect(parsed!.timestamp).toBeNull();
    expect(parsed!.payload).toBeNull(); // no `payload` key on the line
  });

  it("normalizes the legacy first line (no type field)", () => {
    const parsed = parseCodexLine(UNWRAPPED_LEGACY_FIRST);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBeNull();
    expect(parsed!.timestamp).toBe("2025-10-29T14:34:12.586Z");
    expect(parsed!.raw["id"]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("returns null for invalid JSON", () => {
    expect(parseCodexLine("not-json{")).toBeNull();
  });

  it("returns null for JSON arrays or primitives", () => {
    expect(parseCodexLine("[1,2,3]")).toBeNull();
    expect(parseCodexLine('"a string"')).toBeNull();
    expect(parseCodexLine("42")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCodexTranscript
// ---------------------------------------------------------------------------

describe("readCodexTranscript", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentex-codex-read-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty iterable for a missing file", async () => {
    const out: unknown[] = [];
    for await (const e of readCodexTranscript({ filePath: path.join(dir, "missing.jsonl") })) {
      out.push(e);
    }
    expect(out).toEqual([]);
  });

  it("yields wrapped + unwrapped lines in order with monotonic offsets", async () => {
    const file = path.join(dir, "mixed.jsonl");
    const content =
      [SESSION_META_LINE, EVENT_MSG_LINE, RESPONSE_ITEM_LINE, UNWRAPPED_LEGACY_MESSAGE].join("\n") +
      "\n";
    await writeFile(file, content);

    const types: (string | null)[] = [];
    const offsets: number[] = [];
    for await (const { event: parsed, offset } of readCodexTranscript({ filePath: file })) {
      types.push(parsed.type);
      offsets.push(offset);
    }
    expect(types).toEqual(["session_meta", "event_msg", "response_item", "message"]);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    expect(offsets[offsets.length - 1]).toBe(content.length);
  });

  it("resumes from a yielded offset", async () => {
    const file = path.join(dir, "resume.jsonl");
    await writeFile(
      file,
      [SESSION_META_LINE, EVENT_MSG_LINE, RESPONSE_ITEM_LINE].join("\n") + "\n",
    );
    const all: { type: string | null; offset: number }[] = [];
    for await (const { event: parsed, offset } of readCodexTranscript({ filePath: file })) {
      all.push({ type: parsed.type, offset });
    }
    const after = all.find((a) => a.type === "event_msg")!.offset;
    const tail: string[] = [];
    for await (const { event: parsed } of readCodexTranscript({
      filePath: file,
      fromOffset: after,
    })) {
      tail.push(parsed.type ?? "<null>");
    }
    expect(tail).toEqual(["response_item"]);
  });

  it("skips malformed lines", async () => {
    const file = path.join(dir, "bad.jsonl");
    await writeFile(file, [SESSION_META_LINE, "{bad", RESPONSE_ITEM_LINE].join("\n") + "\n");
    const types: (string | null)[] = [];
    for await (const { event: parsed } of readCodexTranscript({ filePath: file })) {
      types.push(parsed.type);
    }
    expect(types).toEqual(["session_meta", "response_item"]);
  });
});

// ---------------------------------------------------------------------------
// peekCodexTranscript
// ---------------------------------------------------------------------------

describe("peekCodexTranscript", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentex-codex-peek-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nulls for a missing file", async () => {
    const res = await peekCodexTranscript(path.join(dir, "missing.jsonl"));
    expect(res).toEqual({ lastEvent: null, size: null });
  });

  it("returns zero size for an empty file", async () => {
    const file = path.join(dir, "empty.jsonl");
    await writeFile(file, "");
    expect(await peekCodexTranscript(file)).toEqual({ lastEvent: null, size: 0 });
  });

  it("returns the last line for a normal file", async () => {
    const file = path.join(dir, "ok.jsonl");
    const content = [SESSION_META_LINE, RESPONSE_ITEM_LINE].join("\n") + "\n";
    await writeFile(file, content);
    const res = await peekCodexTranscript(file);
    expect(res.size).toBe(content.length);
    expect(res.lastEvent?.type).toBe("response_item");
  });

  it("walks past trailing garbage line", async () => {
    const file = path.join(dir, "trailing.jsonl");
    await writeFile(file, [RESPONSE_ITEM_LINE, "garbage{"].join("\n") + "\n");
    const res = await peekCodexTranscript(file);
    expect(res.lastEvent?.type).toBe("response_item");
  });

  it("reads tail of a large file", async () => {
    const file = path.join(dir, "big.jsonl");
    const filler = line({
      timestamp: "2026-05-08T22:01:59.300Z",
      type: "event_msg",
      payload: { type: "x".repeat(200) },
    });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(filler);
    lines.push(RESPONSE_ITEM_LINE);
    await writeFile(file, lines.join("\n") + "\n");
    const res = await peekCodexTranscript(file);
    expect(res.lastEvent?.type).toBe("response_item");
  });
});

// ---------------------------------------------------------------------------
// readCodexCwd (resume-by-id case for codex)
// ---------------------------------------------------------------------------

describe("readCodexCwd", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentex-codex-cwd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts cwd from the wrapped session_meta line (≥0.10 format)", async () => {
    const file = path.join(dir, "wrapped.jsonl");
    await writeFile(file, [SESSION_META_LINE, EVENT_MSG_LINE].join("\n") + "\n");
    expect(await readCodexCwd(file)).toBe("/Users/turing/test");
  });

  it("extracts cwd from the legacy XML environment_context message", async () => {
    const file = path.join(dir, "legacy-xml.jsonl");
    const envCtx = line({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/Users/turing/old-project</cwd>\n  <sandbox>x</sandbox>\n</environment_context>",
        },
      ],
    });
    await writeFile(file, [UNWRAPPED_LEGACY_FIRST, envCtx].join("\n") + "\n");
    expect(await readCodexCwd(file)).toBe("/Users/turing/old-project");
  });

  it("extracts cwd from the legacy plaintext environment_context message", async () => {
    // Older codex (2025-Q3) used plain text labels rather than XML tags.
    const file = path.join(dir, "legacy-plaintext.jsonl");
    const envCtx = line({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            "<environment_context>\n" +
            "Current working directory: /Users/turing/old-plaintext\n" +
            "Approval policy: on-request\n" +
            "Sandbox mode: workspace-write\n" +
            "</environment_context>",
        },
      ],
    });
    await writeFile(file, [UNWRAPPED_LEGACY_FIRST, envCtx].join("\n") + "\n");
    expect(await readCodexCwd(file)).toBe("/Users/turing/old-plaintext");
  });

  it("returns null when no cwd is recoverable", async () => {
    const file = path.join(dir, "no-cwd.jsonl");
    await writeFile(file, [EVENT_MSG_LINE, RESPONSE_ITEM_LINE].join("\n") + "\n");
    expect(await readCodexCwd(file)).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await readCodexCwd(path.join(dir, "missing.jsonl"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replay-stable synthetic eventId (codex:<sessionId>:<lineStartOffset>)
// ---------------------------------------------------------------------------

describe("readCodexTranscript eventId", () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempCodexHome();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("yields deterministic ids embedding the rollout session id + line offset", async () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const file = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T22-01-59",
      sessionId,
      lines: [SESSION_META_LINE, EVENT_MSG_LINE, RESPONSE_ITEM_LINE],
    });

    const readAll = async () => {
      const out: Array<{ eventId: string | null; offset: number }> = [];
      for await (const y of readCodexTranscript({ filePath: file })) {
        out.push({ eventId: y.event.eventId, offset: y.offset });
      }
      return out;
    };

    const first = await readAll();
    expect(first.length).toBe(3);
    // First line starts at byte 0; each id embeds the session id + START offset.
    expect(first[0]!.eventId).toBe(`codex:${sessionId}:0`);
    for (const y of first) {
      expect(y.eventId).toMatch(new RegExp(`^codex:${sessionId}:\\d+$`));
    }
    // Replay-stable: a second full read yields identical ids.
    expect(await readAll()).toEqual(first);
  });

  it("a resumed read assigns the same id to the same line", async () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const file = await placeRollout(home, {
      year: "2026",
      month: "05",
      day: "08",
      ts: "2026-05-08T22-01-59",
      sessionId,
      lines: [SESSION_META_LINE, EVENT_MSG_LINE],
    });

    const all: Array<{ eventId: string | null; offset: number }> = [];
    for await (const y of readCodexTranscript({ filePath: file })) {
      all.push({ eventId: y.event.eventId, offset: y.offset });
    }
    // Resume from after line 1 — line 2's identity must match the full read.
    const resumed: string[] = [];
    for await (const y of readCodexTranscript({ filePath: file, fromOffset: all[0]!.offset })) {
      resumed.push(y.event.eventId!);
    }
    expect(resumed).toEqual([all[1]!.eventId]);
  });

  it("parseCodexLine standalone leaves eventId null (no file context)", () => {
    expect(parseCodexLine(SESSION_META_LINE)?.eventId).toBeNull();
  });
});
