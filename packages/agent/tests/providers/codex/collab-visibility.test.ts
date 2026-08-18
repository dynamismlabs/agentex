/**
 * Collab items must not disappear.
 *
 * Two ways they used to: the parser reported only the first receiver of a
 * multi-child spawn, and the root `item/completed` branch returned after the
 * collab handler without falling through to the raw `unknown` forward-compat
 * event. Both are silent — the host simply never learns the work exists.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import { parseCodexStreamLine, parseCodexStreamLines } from "../../../src/providers/codex/parse.js";
import type { StreamEvent } from "../../../src/types.js";

function collabLine(item: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: "root-thread", item: { id: "item-1", type: "collabAgentToolCall", ...item } },
  });
}

function drivenSession(): { session: CodexSessionImpl; events: StreamEvent[] } {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin: { write: () => true, end: () => {} }, stdout, stderr, kill: () => true });
  const events: StreamEvent[] = [];
  const session = new CodexSessionImpl(
    proc,
    { onEvent: (event) => { events.push(event); } },
    "/tmp",
    "test-model",
    null,
  );
  // Pin the root thread so these notifications take the root path rather than
  // handleForeignNotification, which deliberately drops foreign items.
  (session as unknown as { _threadId: string | null })._threadId = "root-thread";
  (session as unknown as { _state: string })._state = "thinking";
  return { session, events };
}

/** Feed a line and let the event chain drain — dispatch is queued, not sync. */
async function feed(session: CodexSessionImpl, line: string): Promise<void> {
  (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("collab fan-out parsing", () => {
  it("emits one background_task per receiver, not just the first", () => {
    const events = parseCodexStreamLines(collabLine({
      tool: "spawnAgent",
      prompt: "review the diff",
      receiverThreadIds: ["child-a", "child-b", "child-c"],
      agentsStates: {},
    }));
    expect(events.map((event) => event.type === "background_task" && event.taskId))
      .toEqual(["child-a", "child-b", "child-c"]);
  });

  it("merges receivers with state-only children and deduplicates", () => {
    const events = parseCodexStreamLines(collabLine({
      tool: "spawnAgent",
      receiverThreadIds: ["child-a", "child-b"],
      agentsStates: { "child-b": { status: "running" }, "child-c": { status: "running" } },
    }));
    expect(events.map((event) => event.type === "background_task" && event.taskId))
      .toEqual(["child-a", "child-b", "child-c"]);
  });

  it("still reports unmodeled collab items as unknown", () => {
    const events = parseCodexStreamLines(collabLine({
      tool: "sendInput",
      receiverThreadIds: ["never-seen"],
      agentsStates: {},
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "unknown", subtype: "item/completed:collabAgentToolCall" });
  });

  it("keeps the single-event helper working for existing callers", () => {
    const line = collabLine({ tool: "spawnAgent", receiverThreadIds: ["child-a"], agentsStates: {} });
    expect(parseCodexStreamLine(line)).toMatchObject({ type: "background_task", taskId: "child-a" });
  });
});

describe("background-task bookkeeping", () => {
  function internals(session: CodexSessionImpl) {
    return session as unknown as {
      _backgroundTasks: Map<string, { description: string | null; summary: string | null; terminal: boolean }>;
      _backgroundTaskIdsByPath: Map<string, string>;
      _backgroundTaskPollers: Map<string, unknown>;
    };
  }

  it("gives a parser-registered subagent a reconciliation poller", async () => {
    // subAgentActivity items register a task without going through the collab
    // handler, which was the only place that started a poller. Those tasks had
    // no safety net and depended entirely on the child notification arriving.
    const { session } = drivenSession();
    await feed(session, JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        item: { id: "act-1", type: "subAgentActivity", agentThreadId: "child-x", kind: "started", agentPath: "reviewer" },
      },
    }));
    expect(internals(session)._backgroundTaskPollers.has("child-x")).toBe(true);
  });

  it("releases the unbounded field on terminal but keeps the label and lineage", async () => {
    const { session } = drivenSession();
    const prompt = "a very long spawn prompt that would otherwise be retained forever";
    await feed(session, collabLine({
      tool: "spawnAgent",
      prompt,
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    }));

    await feed(session, collabLine({
      tool: "closeAgent",
      status: "completed",
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    }));

    const record = internals(session)._backgroundTasks.get("child-a");
    // `summary` is the unbounded field (full agent messages, appended per item)
    // and has no reader that outlives the task. `description` does: the
    // reactivation path reads it *because* the record is terminal, so dropping
    // it loses a reactivated child's label permanently.
    expect(record).toMatchObject({ terminal: true, description: prompt, summary: null });
    // Lineage survives too — a grandchild can spawn after its parent finished.
    expect(internals(session)._backgroundTaskIdsByPath.get(prompt)).toBe("child-a");
  });

  it("still suppresses a duplicate terminal edge after the payload is dropped", async () => {
    const { session, events } = drivenSession();
    await feed(session, collabLine({
      tool: "spawnAgent",
      prompt: "task",
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    }));
    const close = collabLine({
      tool: "closeAgent",
      status: "completed",
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    });
    await feed(session, close);
    await feed(session, close);

    const terminal = events.filter((e) => e.type === "background_task" && e.phase === "completed");
    expect(terminal).toHaveLength(1);
    // And no second start edge — a dropped payload must not read as a new task.
    expect(events.filter((e) => e.type === "background_task" && e.phase === "started")).toHaveLength(1);
  });

  it("releases both maps on close", async () => {
    const { session } = drivenSession();
    await feed(session, collabLine({
      tool: "spawnAgent",
      prompt: "task",
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    }));
    expect(internals(session)._backgroundTasks.size).toBeGreaterThan(0);
    await session.close();
    expect(internals(session)._backgroundTasks.size).toBe(0);
    expect(internals(session)._backgroundTaskIdsByPath.size).toBe(0);
  });
});

describe("root collab items keep the forward-compat escape hatch", () => {
  it("forwards a collab item that maps to no task edge", async () => {
    const { session, events } = drivenSession();
    // sendInput addressed to a task the session has never tracked: no edge to
    // dispatch, but the host should still see the wire shape.
    await feed(session, collabLine({
      tool: "sendInput",
      receiverThreadIds: ["unknown-child"],
      agentsStates: {},
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "unknown", subtype: "item/completed:collabAgentToolCall" });
  });

  it("does not double-report an item that already produced a task edge", async () => {
    const { session, events } = drivenSession();
    await feed(session, collabLine({
      tool: "spawnAgent",
      prompt: "do the thing",
      receiverThreadIds: ["child-a"],
      agentsStates: {},
    }));
    expect(events.map((event) => event.type)).toEqual(["background_task"]);
    expect(events[0]).toMatchObject({ taskId: "child-a", phase: "started", status: "running" });
  });
});
