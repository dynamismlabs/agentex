import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Stub the heavy session module so `resume()` delegation is observable without
// spawning a real `codex` CLI (spec §6 step 4).
vi.mock("../../src/providers/codex/session.js", () => ({
  createCodexSession: vi.fn(async () => ({ __mock: "codex-session" })),
}));

import { createCodexSession } from "../../src/providers/codex/session.js";
import { codexProvider } from "../../src/providers/codex/index.js";
import { createSessionRecord, MalformedSessionRecordError } from "../../src/sessions/index.js";
import type { CatchUpYield, SessionRecord } from "../../src/index.js";

const SID = "22222222-2222-2222-2222-222222222222";
const CWD = "/repo";
const TS = "2026-07-02T12:00:00.000Z";

function metaLine(): string {
  return JSON.stringify({ type: "session_meta", timestamp: TS, payload: { id: SID, cwd: CWD } });
}
function assistantLine(): string {
  return JSON.stringify({
    type: "response_item", timestamp: TS,
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
  });
}
function taskCompleteLine(): string {
  return JSON.stringify({
    type: "event_msg", timestamp: TS, payload: { type: "task_complete", last_agent_message: "done" },
  });
}

let home: string;

async function writeRollout(lines: string[]): Promise<void> {
  const dayDir = path.join(home, "sessions", "2026", "07", "02");
  await mkdir(dayDir, { recursive: true });
  await writeFile(path.join(dayDir, `rollout-2026-07-02T12-00-00-${SID}.jsonl`), lines.join("\n") + "\n");
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return createSessionRecord({
    providerType: "codex",
    params: { sessionId: SID, cwd: CWD },
    cwd: CWD,
    displayId: SID,
    ...over,
  });
}

const attach = (rec: SessionRecord) =>
  codexProvider.attachSession!(rec, { env: { CODEX_HOME: home } });

async function collect(iter: AsyncIterable<CatchUpYield>): Promise<CatchUpYield[]> {
  const out: CatchUpYield[] = [];
  for await (const y of iter) out.push(y);
  return out;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agentex-attach-codex-"));
  vi.mocked(createCodexSession).mockClear();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("attachCodexSession — capability + wiring", () => {
  it("reports durableSessions and exposes attachSession", () => {
    expect(codexProvider.capabilities.durableSessions).toBe(true);
    expect(typeof codexProvider.attachSession).toBe("function");
  });
});

describe("attachCodexSession — lastTurn classification", () => {
  it("completed when the rollout ends with task_complete", async () => {
    await writeRollout([metaLine(), assistantLine(), taskCompleteLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("completed");
    expect(att.transcript?.cwd).toBe(CWD);
  });

  it("interrupted when the rollout ends without task_complete", async () => {
    await writeRollout([metaLine(), assistantLine()]);
    const att = await attach(record());
    expect(att.lastTurn).toBe("interrupted");
  });

  it("unknown + empty catchUp + functional resume when no rollout exists", async () => {
    const att = await attach(record());
    expect(att.transcript).toBeNull();
    expect(att.lastTurn).toBe("unknown");
    expect(await collect(att.catchUp())).toEqual([]);
    await att.resume();
    expect(createCodexSession).toHaveBeenCalledTimes(1);
  });
});

describe("attachCodexSession — catchUp", () => {
  it("replays normalized events with increasing offsets and NULL eventIds", async () => {
    await writeRollout([metaLine(), assistantLine(), taskCompleteLine()]);
    const att = await attach(record());
    const events = await collect(att.catchUp());

    // session_meta is dropped; assistant + result survive.
    expect(events.map((e) => e.event.type)).toEqual(["assistant", "result"]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.offset).toBeGreaterThan(events[i - 1]!.offset);
    }
    // Codex has no wire ids — contract is null (spec §9.7).
    expect(events.every((e) => e.eventId === null)).toBe(true);
  });

  it("re-invoking from the last offset yields nothing", async () => {
    await writeRollout([metaLine(), assistantLine(), taskCompleteLine()]);
    const att = await attach(record());
    const first = await collect(att.catchUp());
    const lastOffset = first[first.length - 1]!.offset;
    const second = await collect(att.catchUp({ fromOffset: lastOffset }));
    expect(second).toEqual([]);
  });
});

describe("attachCodexSession — resume delegation", () => {
  it("calls createCodexSession with the normalized sessionParams, spawning nothing before", async () => {
    await writeRollout([metaLine(), taskCompleteLine()]);
    const att = await attach(record());
    expect(createCodexSession).not.toHaveBeenCalled();

    await att.resume({ cwd: "/elsewhere" });
    expect(createCodexSession).toHaveBeenCalledTimes(1);
    expect(createCodexSession).toHaveBeenCalledWith({
      cwd: "/elsewhere",
      sessionParams: { sessionId: SID, cwd: CWD },
    });
  });
});

describe("attachCodexSession — record normalization + errors", () => {
  it("normalizes the record through the codec", async () => {
    await writeRollout([metaLine(), taskCompleteLine()]);
    const att = await attach(record({ displayId: null }));
    expect(att.record.providerType).toBe("codex");
    expect(att.record.params).toEqual({ sessionId: SID, cwd: CWD });
    expect(att.record.displayId).toBe(SID);
  });

  it("accepts thread_id alias in params", async () => {
    await writeRollout([metaLine(), taskCompleteLine()]);
    const rec = createSessionRecord({ providerType: "codex", params: { thread_id: SID, cwd: CWD } });
    const att = await attach(rec);
    expect(att.record.params).toEqual({ sessionId: SID, cwd: CWD });
    expect(att.lastTurn).toBe("completed");
  });

  it("throws MalformedSessionRecordError for a record with no usable sessionId", async () => {
    const bad = createSessionRecord({ providerType: "codex", params: { nope: true } });
    await expect(attach(bad)).rejects.toBeInstanceOf(MalformedSessionRecordError);
  });
});
