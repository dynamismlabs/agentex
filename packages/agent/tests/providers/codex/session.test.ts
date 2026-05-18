import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import type {
  SessionContext,
  StreamEvent,
  TurnResult,
} from "../../../src/types.js";

function makeFakeProc(): { proc: ChildProcess } {
  const stdin = {
    write: (_chunk: string) => true,
    end: () => {},
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};

  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true });
  return { proc };
}

/**
 * Drives a Codex session as if a turn were mid-flight. Bypasses `send()` so
 * tests don't depend on JSON-RPC handshake — exercise the notification
 * dispatch path directly.
 */
function makeDrivenSession(ctx: SessionContext): {
  session: CodexSessionImpl;
  feed: (line: string) => void;
  turnResult: Promise<TurnResult>;
} {
  const { proc } = makeFakeProc();
  const session = new CodexSessionImpl(proc, ctx, "/tmp", "test-model", null);
  const turnResult = new Promise<TurnResult>((resolve, reject) => {
    const s = session as unknown as {
      _pendingResults: Array<{
        resolve: (r: TurnResult) => void;
        reject: (e: Error) => void;
      }>;
      _state: string;
    };
    s._pendingResults.push({ resolve, reject });
    s._state = "thinking";
    // Leave _turnStartedAt as null (the class default) so resolveTurn skips
    // the disk-scan branch and takes the sync deliverTurnResult path.
  });
  const feed = (line: string): void => {
    (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  };
  return { session, feed, turnResult };
}

function ndjson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("CodexSession — onEvent dispatch", () => {
  it("forwards a synthesized result event on turn.completed before resolving", async () => {
    const events: StreamEvent[] = [];
    let resolvedAt = -1;
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    // Accumulate a summary via item.completed (legacy NDJSON shape).
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "final answer" },
    }));

    feed(ndjson({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "test-model",
    }));

    const tr = await turnResult;
    resolvedAt = events.length;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("final answer");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    if (resultEvents[0]?.type === "result") {
      expect(resultEvents[0].text).toBe("final answer");
      expect(resultEvents[0].isError).toBe(false);
    }
    // Result event was queued before TurnResult resolved.
    expect(resolvedAt).toBeGreaterThan(0);
  });

  it("forwards a result event on turn.failed with isError=true", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    feed(ndjson({
      type: "turn.failed",
      message: "model unavailable",
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("failed");
    expect(tr.errorMessage).toBe("model unavailable");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    if (resultEvents[0]?.type === "result") {
      expect(resultEvents[0].isError).toBe(true);
    }
  });

  it("a handler that throws does not block subsequent handlers", async () => {
    const seen: string[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => {
        // Throw on the assistant item; subsequent events must still arrive.
        if (e.type === "assistant" && e.text === "B") throw new Error("boom");
        if (e.type === "assistant") seen.push(`assistant:${e.text}`);
        else seen.push(e.type);
      },
    });

    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "A" },
    }));
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "B" },
    }));
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "C" },
    }));
    feed(ndjson({ type: "turn.completed" }));

    await turnResult;
    expect(seen).toContain("assistant:A");
    expect(seen).not.toContain("assistant:B");
    expect(seen).toContain("assistant:C");
    expect(seen).toContain("result");
  });

  it("awaits async handlers in order before resolving TurnResult", async () => {
    const order: string[] = [];
    let resolveSlow: (() => void) | null = null;
    const slowDone = new Promise<void>((r) => { resolveSlow = r; });

    const { feed, turnResult } = makeDrivenSession({
      onEvent: async (e) => {
        if (e.type === "assistant") {
          await slowDone;
          order.push("slow-handler-done");
        } else if (e.type === "result") {
          order.push("result-handler-done");
        }
      },
    });

    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "slow" },
    }));
    feed(ndjson({ type: "turn.completed" }));

    let turnResolved = false;
    void turnResult.then(() => { turnResolved = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(turnResolved).toBe(false);

    resolveSlow!();
    await turnResult;
    expect(order).toEqual(["slow-handler-done", "result-handler-done"]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent send + cancel — Codex JSON-RPC has no per-message cancel.
// ---------------------------------------------------------------------------

describe("CodexSession — concurrent send", () => {
  it("send() while a turn is in progress no longer throws", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const h1 = await session.send("first");
    expect(h1.uuid).toBeTruthy();
    const h2 = await session.send("second mid-turn");
    expect(h2.uuid).toBeTruthy();
    expect(h2.uuid).not.toBe(h1.uuid);
  });

  it("multiple pending sends share the TurnResult when one turn.completed fires", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const h1 = await session.send("a");
    const h2 = await session.send("b");
    const h3 = await session.send("c");

    // One turn.completed drains every pending resolver with the same result.
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      ndjson({
        type: "item.completed",
        item: { type: "agent_message", text: "shared" },
      }),
    );
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      ndjson({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    );

    const [r1, r2, r3] = await Promise.all([h1.result, h2.result, h3.result]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1.summary).toBe("shared");
  });

  it("per-turn accumulators reset between sequential turns", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    const feed = (line: string): void => {
      (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
    };

    const h1 = await session.send("turn-1");
    feed(ndjson({ type: "item.completed", item: { type: "agent_message", text: "first" } }));
    feed(ndjson({ type: "turn.completed" }));
    const r1 = await h1.result;
    expect(r1.summary).toBe("first");

    // Second turn must NOT inherit the first turn's summary.
    const h2 = await session.send("turn-2");
    feed(ndjson({ type: "turn.completed" }));
    const r2 = await h2.result;
    expect(r2.summary).toBeNull();
  });
});

describe("CodexSession — cancel", () => {
  it("returns {cancelled: false} — Codex has no per-message cancel", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    expect(await session.cancel("any-uuid")).toEqual({ cancelled: false });
  });
});
