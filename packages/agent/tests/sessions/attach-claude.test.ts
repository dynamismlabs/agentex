import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Stub the heavy session module so `resume()` delegation is observable without
// spawning a real `claude` CLI (spec §6 step 4: assert via a spy/stub).
vi.mock("../../src/providers/claude/session.js", () => ({
  createClaudeSession: vi.fn(async () => ({ __mock: "claude-session" })),
}));

import { createClaudeSession } from "../../src/providers/claude/session.js";
import { claudeProvider } from "../../src/providers/claude/index.js";
import { createSessionRecord, MalformedSessionRecordError } from "../../src/sessions/index.js";
import type { CatchUpYield, SessionRecord } from "../../src/index.js";

const SID = "11111111-1111-1111-1111-111111111111";
const CWD = "/work";

function initLine(): string {
  return JSON.stringify({
    type: "system", subtype: "init", cwd: CWD, session_id: SID,
    model: "m", tools: [], permissionMode: "default", uuid: "u-init",
  });
}
function assistantLine(): string {
  return JSON.stringify({
    type: "assistant", session_id: SID,
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "hello" }] },
    uuid: "u-asst",
  });
}
function userLine(): string {
  return JSON.stringify({
    type: "user", session_id: SID,
    message: { id: "msg_user", role: "user", content: "start the next task" },
    uuid: "u-user",
  });
}
function resultLine(): string {
  return JSON.stringify({
    type: "result", subtype: "success", session_id: SID, result: "hello", is_error: false, uuid: "u-result",
  });
}

let home: string;

async function writeTranscript(lines: string[]): Promise<void> {
  // Matches getClaudeTranscriptPath's cwd fast-path: sanitize("/work") === "-work".
  const projectDir = path.join(home, "projects", "-work");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${SID}.jsonl`), lines.join("\n") + "\n");
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return createSessionRecord({
    providerType: "claude",
    params: { sessionId: SID, cwd: CWD },
    cwd: CWD,
    displayId: SID,
    ...over,
  });
}

const attach = (rec: SessionRecord) =>
  claudeProvider.attachSession!(rec, { env: { CLAUDE_CONFIG_DIR: home } });

async function collect(iter: AsyncIterable<CatchUpYield>): Promise<CatchUpYield[]> {
  const out: CatchUpYield[] = [];
  for await (const y of iter) out.push(y);
  return out;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agentex-attach-claude-"));
  vi.mocked(createClaudeSession).mockClear();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("attachClaudeSession — capability + wiring", () => {
  it("reports durableSessions and exposes attachSession", () => {
    expect(claudeProvider.capabilities.durableSessions).toBe(true);
    expect(typeof claudeProvider.attachSession).toBe("function");
  });
});

describe("attachClaudeSession — lastTurn classification", () => {
  it("completed when the transcript ends with a result", async () => {
    await writeTranscript([initLine(), assistantLine(), resultLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("completed");
    expect(att.transcript).not.toBeNull();
  });

  it("ignores trailing system telemetry after a completed turn", async () => {
    await writeTranscript([initLine(), assistantLine(), resultLine(), ...Array(200).fill(initLine())]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("completed");
  });

  it("detects new turn activity after an earlier result", async () => {
    await writeTranscript([initLine(), resultLine(), assistantLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("interrupted");
  });

  it("treats an ordinary user prompt after a result as a new interrupted turn", async () => {
    await writeTranscript([initLine(), resultLine(), userLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("interrupted");
  });

  it("interrupted when the transcript ends without a result", async () => {
    await writeTranscript([initLine(), assistantLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("interrupted");
  });

  it("unknown + empty catchUp + functional resume when no transcript exists", async () => {
    const att = await attach(record());
    expect(att.transcript).toBeNull();
    expect(att.lastTurn).toBe("unknown");
    expect(await collect(att.catchUp())).toEqual([]);
    // resume still works (provider state may live elsewhere).
    await att.resume();
    expect(createClaudeSession).toHaveBeenCalledTimes(1);
  });
});

describe("attachClaudeSession — catchUp", () => {
  it("replays events with monotonically increasing offsets and non-null eventIds", async () => {
    await writeTranscript([initLine(), assistantLine(), resultLine()]);
    const att = await attach(record());
    const events = await collect(att.catchUp());

    expect(events.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.offset).toBeGreaterThan(events[i - 1]!.offset);
    }
    // Claude carries a stable wire uuid per line.
    expect(events.every((e) => e.eventId !== null)).toBe(true);
    expect(events.map((e) => e.eventId)).toContain("u-init");
    expect(events.some((e) => e.event.type === "result")).toBe(true);
  });

  it("re-invoking from the last offset yields nothing", async () => {
    await writeTranscript([initLine(), assistantLine(), resultLine()]);
    const att = await attach(record());
    const first = await collect(att.catchUp());
    const lastOffset = first[first.length - 1]!.offset;
    const second = await collect(att.catchUp({ fromOffset: lastOffset }));
    expect(second).toEqual([]);
  });
});

describe("attachClaudeSession — resume delegation", () => {
  it("calls createClaudeSession with the normalized sessionParams, spawning nothing before", async () => {
    await writeTranscript([initLine(), resultLine()]);
    const att = await attach(record());
    // Nothing spawned during attach/catchUp.
    expect(createClaudeSession).not.toHaveBeenCalled();

    await att.resume({ cwd: "/elsewhere" });
    expect(createClaudeSession).toHaveBeenCalledTimes(1);
    expect(createClaudeSession).toHaveBeenCalledWith({
      cwd: "/elsewhere",
      sessionParams: { sessionId: SID, cwd: CWD },
    });
  });

  it("resume works with no ctx", async () => {
    await writeTranscript([initLine(), resultLine()]);
    const att = await attach(record());
    await att.resume();
    expect(createClaudeSession).toHaveBeenCalledWith({
      cwd: CWD,
      sessionParams: { sessionId: SID, cwd: CWD },
    });
  });
});

describe("attachClaudeSession — record normalization + errors", () => {
  it("normalizes the record through the codec", async () => {
    await writeTranscript([initLine(), resultLine()]);
    const att = await attach(record({ displayId: null }));
    expect(att.record.version).toBe(1);
    expect(att.record.providerType).toBe("claude");
    expect(att.record.params).toEqual({ sessionId: SID, cwd: CWD });
    expect(att.record.displayId).toBe(SID);
  });

  it("throws MalformedSessionRecordError for a record with no usable sessionId", async () => {
    const bad = createSessionRecord({ providerType: "claude", params: { nope: true } });
    await expect(attach(bad)).rejects.toBeInstanceOf(MalformedSessionRecordError);
  });

  it("throws MalformedSessionRecordError for a structurally invalid record", async () => {
    const bad = { version: 2, providerType: "claude", params: {}, cwd: null, displayId: null, updatedAt: "x" } as unknown as SessionRecord;
    await expect(attach(bad)).rejects.toBeInstanceOf(MalformedSessionRecordError);
  });

  it("rejects a structurally valid record owned by another provider", async () => {
    await expect(attach(record({ providerType: "codex" })))
      .rejects.toMatchObject({ name: "MalformedSessionRecordError", path: "providerType" });
  });
});
