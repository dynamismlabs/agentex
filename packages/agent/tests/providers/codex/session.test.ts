import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import { parseAskUserQuestion } from "../../../src/index.js";
import type {
  SessionContext,
  StreamEvent,
  TurnResult,
  UserInputRequest,
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

// ---------------------------------------------------------------------------
// Per-send timeout / abort (SendOptions)
// ---------------------------------------------------------------------------

function feedCodex(session: CodexSessionImpl, obj: Record<string, unknown>): void {
  (session as unknown as { handleLine: (l: string) => void }).handleLine(JSON.stringify(obj));
}

describe("CodexSession — per-send timeout / abort", () => {
  it("resolves status 'timeout' when the deadline fires", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const handle = await session.send("slow", { timeoutSec: 0.02 });
    const tr = await handle.result;
    expect(tr.status).toBe("timeout");
    expect(tr.errorCode).toBe("timeout");
  });

  it("falls back to ProviderConfig.timeoutSec as the session-level default", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, { config: { timeoutSec: 0.02 } }, "/tmp", "test-model", null);

    const handle = await session.send("task");
    const tr = await handle.result;
    expect(tr.status).toBe("timeout");
  });

  it("a real result before the timeout wins", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const handle = await session.send("task", { timeoutSec: 100 });
    feedCodex(session, { type: "item.completed", item: { type: "agent_message", text: "done" } });
    // Usage present → sync delivery (no disk-scan branch).
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

    const tr = await handle.result;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("done");
  });

  it("SendOptions.signal abort resolves status 'aborted'", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const ac = new AbortController();
    const handle = await session.send("task", { signal: ac.signal });
    ac.abort();

    const tr = await handle.result;
    expect(tr.status).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

describe("CodexSession — drain", () => {
  it("refuses new sends while draining, awaits the in-flight turn, then closes", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, { config: { graceSec: 0.02 } }, "/tmp", "test-model", null);

    const handle = await session.send("task");
    const drainP = session.drain();

    await expect(session.send("nope")).rejects.toThrow(/draining/);

    // Usage present → sync delivery, no disk scan.
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    const tr = await handle.result;
    expect(tr.status).toBe("completed");

    await drainP;
    expect(session.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// tool_result.toolName (Codex sets it directly in the parser)
// ---------------------------------------------------------------------------

describe("CodexSession — tool_result.toolName", () => {
  it("emits tool_result.toolName for command_execution items", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    feed(ndjson({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "ls" } }));
    feed(ndjson({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", aggregated_output: "files", exit_code: 0 },
    }));
    feed(ndjson({ type: "turn.completed" }));

    await turnResult;
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.toolName).toBe("command_execution");
  });
});

// ---------------------------------------------------------------------------
// Handshake — thread/start (fresh) vs thread/resume (continue a session)
// ---------------------------------------------------------------------------

/** A JSON-RPC error to return from a makeRpcProc handler. */
class RpcError {
  constructor(
    public readonly code: number,
    public readonly rpcMessage: string,
  ) {}
}

/**
 * Fake child process that auto-responds to outgoing JSON-RPC *requests* using a
 * per-method handler map, and records every message the session writes to
 * stdin. A handler returning an RpcError yields a JSON-RPC error response.
 */
function makeRpcProc(handlers: Record<string, (params: Record<string, unknown>) => unknown>): {
  proc: ChildProcess;
  writes: Array<Record<string, unknown>>;
} {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const writes: Array<Record<string, unknown>> = [];

  const stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        writes.push(msg);
        if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
          const id = msg["id"] as number;
          const handler = handlers[msg["method"] as string];
          const out = handler ? handler((msg["params"] as Record<string, unknown>) ?? {}) : {};
          queueMicrotask(() => {
            const response =
              out instanceof RpcError
                ? { jsonrpc: "2.0", id, error: { code: out.code, message: out.rpcMessage } }
                : { jsonrpc: "2.0", id, result: out };
            stdout.emit("data", JSON.stringify(response) + "\n");
          });
        }
      }
      return true;
    },
    end: () => {},
  };

  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true });
  return { proc, writes };
}

function methodsWritten(writes: Array<Record<string, unknown>>): string[] {
  return writes.map((w) => w["method"]).filter((m): m is string => typeof m === "string");
}

function paramsFor(writes: Array<Record<string, unknown>>, method: string): Record<string, unknown> {
  const msg = writes.find((w) => w["method"] === method);
  return (msg?.["params"] as Record<string, unknown>) ?? {};
}

describe("CodexSession — handshake resume", () => {
  it("starts a fresh thread (thread/start) when no sessionParams are given", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_fresh" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/start");
    expect(methods).not.toContain("thread/resume");
    expect(session.sessionId).toBe("thr_fresh");
  });

  it("resumes an existing thread (thread/resume) when sessionParams carry a sessionId", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
      "thread/start": () => ({ thread: { id: "thr_should_not_be_used" } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_existing" } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(session.sessionId).toBe("thr_existing");
    expect(paramsFor(writes, "thread/resume")["threadId"]).toBe("thr_existing");
  });

  it("recovers the resume id from the thread_id alias", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { thread_id: "thr_alias" } },
      "/tmp",
      null,
      null,
    );
    await session.handshake();
    expect(methodsWritten(writes)).toContain("thread/resume");
    expect(session.sessionId).toBe("thr_alias");
  });

  it("passes developerInstructions on resume and falls back to the resumed id when the response is empty", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": () => ({}),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_x" } },
      "/tmp",
      null,
      "Be concise.",
    );
    await session.handshake();
    expect(paramsFor(writes, "thread/resume")["developerInstructions"]).toBe("Be concise.");
    expect(session.sessionId).toBe("thr_x");
  });

  it("falls back to a fresh thread (with a stderr notice) when resume is rejected", async () => {
    const stderr: string[] = [];
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": () => new RpcError(-32000, "unknown thread"),
      "thread/start": () => ({ thread: { id: "thr_new" } }),
    });
    const session = new CodexSessionImpl(
      proc,
      {
        sessionParams: { sessionId: "thr_gone" },
        onOutput: (stream, chunk) => {
          if (stream === "stderr") stderr.push(chunk);
        },
      },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/resume");
    expect(methods).toContain("thread/start"); // fell back to a fresh thread
    expect(session.sessionId).toBe("thr_new");
    expect(stderr.join("")).toMatch(/thread\/resume failed/);
  });
});

// ---------------------------------------------------------------------------
// Permission requests (server→client): command/file approval + requestUserInput
// ---------------------------------------------------------------------------

/** Emit a server→client JSON-RPC request to the session and return the result
 *  the session writes back (its `rpcResponse`). */
async function emitServerRequest(
  proc: ChildProcess,
  writes: Array<Record<string, unknown>>,
  request: { id: number; method: string; params: Record<string, unknown> },
): Promise<Record<string, unknown> | undefined> {
  const stdout = (proc as unknown as { stdout: EventEmitter }).stdout;
  stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
  // Let the async onUserInputRequest + rpcResponse settle.
  await new Promise((r) => setTimeout(r, 10));
  const resp = writes.find((w) => w["id"] === request.id && "result" in w);
  return resp?.["result"] as Record<string, unknown> | undefined;
}

describe("CodexSession — permission requests", () => {
  it("responds { decision: 'accept' } to a command approval the host allows", async () => {
    const { proc, writes } = makeRpcProc({});
    const seen: string[] = [];
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async (req) => { seen.push(req.toolName); return { allow: true }; } },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { id: "item_1", command: "rm -rf /tmp/x" },
    });
    expect(result).toEqual({ decision: "accept" });
    expect(seen).toEqual(["command_execution"]);
  });

  it("responds { decision: 'decline' } when the host denies a file change", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: false, message: "no" }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 101,
      method: "item/fileChange/requestApproval",
      params: { id: "item_2", path: "/etc/hosts" },
    });
    expect(result).toEqual({ decision: "decline" });
  });

  it("auto-accepts (decision: 'accept') when no host handler is registered", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(proc, {}, "/tmp", "m", null);
    const result = await emitServerRequest(proc, writes, {
      id: 102,
      method: "item/commandExecution/requestApproval",
      params: { id: "item_3", command: "ls" },
    });
    expect(result).toEqual({ decision: "accept" });
  });

  it("maps requestUserInput to AskUserQuestion and answers by question id", async () => {
    const { proc, writes } = makeRpcProc({});
    const calls: UserInputRequest[] = [];
    new CodexSessionImpl(
      proc,
      {
        onUserInputRequest: async (req) => {
          calls.push(req);
          // Host answers keyed by question text (agentex AskUserQuestion convention).
          return { allow: true, updatedInput: { answers: { "Pick a framework": "Hono" } } };
        },
      },
      "/tmp",
      "m",
      null,
    );

    const result = await emitServerRequest(proc, writes, {
      id: 103,
      method: "item/tool/requestUserInput",
      params: {
        id: "q_call_1",
        questions: [
          {
            id: "framework",
            header: "Framework",
            question: "Pick a framework",
            options: [{ label: "Express" }, { label: "Hono" }],
          },
        ],
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("AskUserQuestion");
    // The mapped request is parseAskUserQuestion-compatible.
    const parsed = parseAskUserQuestion(calls[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.question).toBe("Pick a framework");
    expect(parsed![0]!.options.map((o) => o.label)).toEqual(["Express", "Hono"]);
    expect(result).toEqual({ answers: { framework: { answers: ["Hono"] } } });
  });

  it("handles the legacy tool/requestUserInput method and multi-select answers", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: true, updatedInput: { answers: { "Q?": ["a", "b"] } } }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 104,
      method: "tool/requestUserInput",
      params: {
        id: "c",
        questions: [{ id: "x", header: "H", question: "Q?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] }],
      },
    });
    expect(result).toEqual({ answers: { x: { answers: ["a", "b"] } } });
  });

  it("uses waiting_for_input state for questions and restores to idle (not thinking) with no active turn", async () => {
    const { proc, writes } = makeRpcProc({});
    const holder: { session?: CodexSessionImpl } = {};
    const states: string[] = [];
    holder.session = new CodexSessionImpl(
      proc,
      {
        onUserInputRequest: async () => {
          states.push(holder.session!.state);
          return { allow: true, updatedInput: { answers: { "Q?": "a" } } };
        },
      },
      "/tmp",
      "m",
      null,
    );
    await emitServerRequest(proc, writes, {
      id: 200,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "x", header: "H", question: "Q?", options: [{ label: "a" }] }] },
    });
    expect(states).toEqual(["waiting_for_input"]);
    // No turn was in flight, so the state must restore to idle — never clobbered to "thinking".
    expect(holder.session.state).toBe("idle");
  });

  it("answers a header-only question (no `question` text)", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: true, updatedInput: { answers: { Branch: "main" } } }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 201,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "branch", header: "Branch", options: [{ label: "main" }] }] },
    });
    // The header is used as the prompt text, so the host's answer (keyed by it) lands.
    expect(result).toEqual({ answers: { branch: { answers: ["main"] } } });
  });

  it("returns empty answers when the host declines a requestUserInput", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: false }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 105,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "x", header: "H", question: "Q?", options: [] }] },
    });
    expect(result).toEqual({ answers: {} });
  });
});

// ---------------------------------------------------------------------------
// Collaboration mode selection (config.modeId)
// ---------------------------------------------------------------------------

describe("CodexSession — usage", () => {
  it("uses turn.completed usage verbatim (keyed by model) and skips the disk scan", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "gpt-x", null);
    const h = await session.send("go"); // sets _turnStartedAt
    feedCodex(session, { type: "item.completed", item: { type: "agent_message", text: "done" } });
    // Usage present in the payload → the `if (!usage)` guard skips the scanner.
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 42, output_tokens: 7 } });
    const tr = await h.result;
    expect(tr.status).toBe("completed");
    expect(tr.usage).toEqual({ "gpt-x": { inputTokens: 42, outputTokens: 7 } });
  });
});

describe("CodexSession — collaboration mode", () => {
  it("resolves modeId via collaborationMode/list and passes collaborationMode to thread/start", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "collaborationMode/list": () => ({
        data: [
          { name: "Auto", mode: "code", model: "gpt-5.4" },
          { name: "Plan", mode: "plan", developer_instructions: "Investigate only." },
        ],
      }),
      "thread/start": () => ({ thread: { id: "thr_mode" } }),
    });
    const session = new CodexSessionImpl(proc, { config: { modeId: "plan" } }, "/tmp", null, null);
    await session.handshake();

    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toEqual({
      mode: "plan",
      settings: { developer_instructions: "Investigate only." },
    });
    expect(session.sessionId).toBe("thr_mode");
  });

  it("makes no collaborationMode/list call and sets no mode when modeId is unset", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_default" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", null, null);
    await session.handshake();

    expect(methodsWritten(writes)).not.toContain("collaborationMode/list");
    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toBeUndefined();
    expect(session.sessionId).toBe("thr_default");
  });

  it("falls through to the default mode when modeId is unknown", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "collaborationMode/list": () => ({ data: [{ name: "Auto", mode: "code" }] }),
      "thread/start": () => ({ thread: { id: "thr_x" } }),
    });
    const session = new CodexSessionImpl(proc, { config: { modeId: "nonexistent" } }, "/tmp", null, null);
    await session.handshake();

    expect(methodsWritten(writes)).toContain("collaborationMode/list"); // it tried to resolve
    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toBeUndefined(); // no match → default
  });
});
