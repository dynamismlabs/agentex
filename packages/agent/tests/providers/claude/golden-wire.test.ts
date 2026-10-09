import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { ClaudeSessionImpl } from "../../../src/providers/claude/session.js";
import type { StreamEvent } from "../../../src/types.js";

/**
 * Replay of a real Claude Code session, captured verbatim off the wire.
 *
 * The synthetic tests elsewhere assert one behavior each against hand-written
 * lines. This asserts the state machine's invariants against a trace nobody
 * designed — including the orderings that broke earlier versions: a subagent
 * streaming onto the parent after the root result, a completion arriving as
 * two records, and a resume turn headed by `system/init`.
 *
 * Re-capture with a live CLI if the wire format changes; do not hand-edit.
 */
const FIXTURE = fileURLToPath(
  new URL("../../fixtures/claude-subagent-resume-turn.jsonl", import.meta.url),
);

function replay(): { events: StreamEvent[]; session: ClaudeSessionImpl } {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => {} }), stdout, stderr, kill: () => true });

  const events: StreamEvent[] = [];
  const session = new ClaudeSessionImpl(proc, { onEvent: (e) => { events.push(e); } }, null);
  // One outstanding host message, as if send() had written it.
  (session as unknown as { _outstandingCommands: Set<string> })._outstandingCommands.add("cmd-1");

  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (line.trim()) (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  }
  return { events, session };
}

const of = (events: StreamEvent[], type: string) => events.filter((e) => e.type === type);

describe("golden wire — subagent with a provider-initiated resume turn", () => {
  it("produces exactly two turns, the second provider-initiated", async () => {
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;

    const starts = of(events, "turn_start");
    expect(starts.map((e) => (e as { trigger: string }).trigger)).toEqual(["send", "resume"]);
  });

  it("balances every turn_start with one turn_end of the same id", async () => {
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;

    const ids = (t: string) => of(events, t).map((e) => (e as { turnId: string }).turnId);
    expect(ids("turn_end")).toEqual(ids("turn_start"));
    expect(of(events, "turn_end").every((e) => (e as { reason: string }).reason === "result")).toBe(true);
  });

  it("leaves the session idle with no turn open", async () => {
    const { session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;
    expect((session as unknown as { _openTurn: unknown })._openTurn).toBeNull();
    expect(session.state).toBe("idle");
  });

  it("never opens a turn on the subagent's own output", async () => {
    // The child streams onto the parent between the root result and the resume
    // turn. Those lines must not be mistaken for the session working.
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;
    expect(of(events, "turn_start")).toHaveLength(2);
  });

  it("reports the completion once, on the record that delivered it", async () => {
    // `task_updated` and `task_notification` both say completed; only the
    // notification hands the result back.
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;

    const terminal = of(events, "background_task")
      .filter((e) => (e as { phase: string }).phase === "completed");
    expect(terminal.length).toBeGreaterThanOrEqual(2);
    expect(terminal.filter((e) => (e as { report: unknown }).report !== null)).toHaveLength(1);
  });

  it("keeps the subagent's type and description on its completion", async () => {
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;

    const delivered = of(events, "background_task")
      .find((e) => (e as { report: unknown }).report !== null) as
        { taskType: string; description: string | null; toolUseId: string | null } | undefined;
    expect(delivered?.taskType).toBe("subagent");
    expect(delivered?.description).toBeTruthy();
    expect(delivered?.toolUseId).toBeTruthy();
  });

  it("attributes every nested event to the call that launched it", async () => {
    const { events, session } = replay();
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;

    const nested = events.filter((e) => e.parentToolCallId !== null);
    expect(nested.length).toBeGreaterThan(0);
    expect(new Set(nested.map((e) => e.parentToolCallId)).size).toBe(1);
  });
});
