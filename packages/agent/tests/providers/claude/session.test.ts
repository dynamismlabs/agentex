import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  ClaudeSessionImpl,
  buildPermissionResponse,
} from "../../../src/providers/claude/session.js";
import type {
  SessionContext,
  StreamEvent,
  TurnResult,
} from "../../../src/types.js";

// ---------------------------------------------------------------------------
// buildPermissionResponse — pre-existing unit tests
// ---------------------------------------------------------------------------

describe("buildPermissionResponse", () => {
  const toolUseId = "tool_use_42";
  const input = { command: "ls", path: "/tmp" };

  it("auto-allow path includes updatedInput echoing the original input", () => {
    // Regression: when no host callback is registered, the auto-allow response
    // used to omit `updatedInput`, and the CLI's PermissionResultAllow schema
    // would reject it via discriminated-union fall-through ("expected 'deny'").
    const resp = buildPermissionResponse(toolUseId, input, null);
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: input,
    });
  });

  it("allow with no updatedInput defaults to the original input", () => {
    // Regression: the same shape bug existed in the callback path. A host that
    // returned `{ allow: true }` without an explicit updatedInput got a wire
    // response missing the required field.
    const resp = buildPermissionResponse(toolUseId, input, { allow: true });
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: input,
    });
  });

  it("allow honors a host-supplied updatedInput", () => {
    const updated = { command: "ls", path: "/safe" };
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: true,
      updatedInput: updated,
    });
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: updated,
    });
  });

  it("allow includes an optional host message", () => {
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: true,
      message: "approved by policy",
    });
    expect(resp).toMatchObject({
      behavior: "allow",
      message: "approved by policy",
      updatedInput: input,
    });
  });

  it("deny does not include updatedInput", () => {
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: false,
      message: "user rejected",
    });
    expect(resp).toEqual({
      behavior: "deny",
      toolUseID: toolUseId,
      message: "user rejected",
    });
    expect(resp).not.toHaveProperty("updatedInput");
  });

  it("deny without a message still produces a valid shape", () => {
    const resp = buildPermissionResponse(toolUseId, input, { allow: false });
    expect(resp).toEqual({
      behavior: "deny",
      toolUseID: toolUseId,
    });
  });
});

// ---------------------------------------------------------------------------
// Stream event forwarding through the awaited dispatch chain
// ---------------------------------------------------------------------------

/**
 * Minimal ChildProcess stand-in: stdin captures writes for later inspection,
 * stdout/stderr are EventEmitters so we can feed synthetic CLI output, and
 * the process itself is an EventEmitter for 'exit'/'error'.
 */
function makeFakeProc(): {
  proc: ChildProcess;
  stdinWrites: string[];
} {
  const stdinWrites: string[] = [];
  const stdin = {
    write: (chunk: string) => { stdinWrites.push(chunk); return true; },
    end: () => {},
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};

  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true });

  return { proc, stdinWrites };
}

/**
 * Drives a session as if a turn were mid-flight: returns the session, a
 * `feed` helper for pushing raw NDJSON lines through `handleLine`, and the
 * Promise that resolves with the next TurnResult. Bypasses `send()` so tests
 * don't depend on the full handshake — just the event/result dispatch path.
 */
function makeDrivenSession(ctx: SessionContext): {
  session: ClaudeSessionImpl;
  feed: (line: string) => void;
  turnResult: Promise<TurnResult>;
} {
  const { proc } = makeFakeProc();
  const session = new ClaudeSessionImpl(proc, ctx, null);
  const turnResult = new Promise<TurnResult>((resolve, reject) => {
    (session as unknown as {
      _pendingResults: Array<{
        resolve: (r: TurnResult) => void;
        reject: (e: Error) => void;
      }>;
      _state: string;
    })._pendingResults.push({ resolve, reject });
    (session as unknown as { _state: string })._state = "thinking";
  });
  const feed = (line: string): void => {
    (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  };
  return { session, feed, turnResult };
}

function ndjson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("ClaudeSession — onEvent dispatch", () => {
  it("forwards the wire result event through onEvent", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    feed(ndjson({
      type: "result",
      subtype: "success",
      session_id: "s1",
      result: "done",
      total_cost_usd: 0.01,
      is_error: false,
      stop_reason: "end_turn",
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("done");
    expect(events.map((e) => e.type)).toContain("result");
  });

  it("emits auth_required and result through onEvent on auth failure", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    feed(ndjson({
      type: "result",
      subtype: "error_during_execution",
      session_id: "s1",
      result: "OAuth token has expired · Please run /login",
      is_error: true,
      api_error_status: 401,
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("failed");
    expect(tr.errorCode).toBe("auth_required");

    const types = events.map((e) => e.type);
    expect(types).toContain("auth_required");
    expect(types).toContain("result");
    // auth_required arrives before result so consumers can dispatch UI
    // updates ahead of the terminal frame.
    expect(types.indexOf("auth_required")).toBeLessThan(types.indexOf("result"));
  });

  it("does not double-emit auth_required (regression on the deleted workaround)", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    feed(ndjson({
      type: "result",
      subtype: "error_during_execution",
      session_id: "s1",
      result: "OAuth token has expired · Please run /login",
      is_error: true,
      api_error_status: 401,
    }));

    await turnResult;
    const authEvents = events.filter((e) => e.type === "auth_required");
    expect(authEvents).toHaveLength(1);
  });

  it("errorMessage uses the auth variant after the single-call hoist", async () => {
    const { feed, turnResult } = makeDrivenSession({});

    feed(ndjson({
      type: "result",
      subtype: "error_during_execution",
      session_id: "s1",
      result: "OAuth token has expired",
      is_error: true,
      api_error_status: 401,
    }));

    const tr = await turnResult;
    expect(tr.errorCode).toBe("auth_required");
    expect(tr.errorMessage).toContain("OAuth token has expired");
    expect(tr.errorMessage).toContain("claude");
    expect(tr.errorMessage).toContain("login");
  });

  it("a handler that throws does not block subsequent handlers", async () => {
    const seen: string[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => {
        if (e.type === "assistant" && e.text === "B") throw new Error("boom");
        seen.push(e.type === "assistant" ? `assistant:${e.text}` : e.type);
      },
    });

    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      message: {
        id: "msg_A",
        role: "assistant",
        content: [{ type: "text", text: "A" }],
      },
    }));
    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      message: {
        id: "msg_B",
        role: "assistant",
        content: [{ type: "text", text: "B" }],
      },
    }));
    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      message: {
        id: "msg_C",
        role: "assistant",
        content: [{ type: "text", text: "C" }],
      },
    }));
    feed(ndjson({
      type: "result",
      subtype: "success",
      session_id: "s1",
      result: "done",
      is_error: false,
    }));

    await turnResult;
    expect(seen).toEqual(["assistant:A", "assistant:C", "result"]);
  });

  it("does not overwrite 'closed' state if process exits during chain drain", async () => {
    // Regression: making handleResult async opens a window where exit
    // can fire while await this._eventChain is suspended. If handleResult
    // resumes and unconditionally sets state to "idle", the session falsely
    // advertises itself as usable.
    let resolveSlow: (() => void) | null = null;
    const slowDone = new Promise<void>((r) => { resolveSlow = r; });

    const { session, feed, turnResult } = makeDrivenSession({
      onEvent: async (e) => {
        if (e.type === "result") await slowDone;
      },
    });

    feed(ndjson({
      type: "result",
      subtype: "success",
      session_id: "s1",
      result: "done",
      is_error: false,
    }));

    // Simulate process exit while result handler is still draining.
    await new Promise((r) => setTimeout(r, 5));
    (session as unknown as { _state: string })._state = "closed";
    // Drain pending resolvers and reject the awaiting Promise — emulates
    // the exit-handler's rejectAllPending() path without double-resolving
    // when handleResult resumes (its splice will then find an empty list).
    const pending = (session as unknown as {
      _pendingResults: Array<{
        resolve: (r: TurnResult) => void;
        reject: (e: Error) => void;
      }>;
    })._pendingResults.splice(0);
    for (const p of pending) p.reject(new Error("simulated exit"));

    // Unblock chain — handleResult resumes after this.
    resolveSlow!();
    await turnResult.catch(() => {}); // already rejected

    // State must remain "closed" — the resumed handleResult should NOT have
    // flipped it back to "idle".
    expect(session.state).toBe("closed");
  });

  it("awaits async handlers in order before resolving TurnResult", async () => {
    const order: string[] = [];
    let resolveSlow: (() => void) | null = null;
    const slowDone = new Promise<void>((r) => { resolveSlow = r; });

    const { feed, turnResult } = makeDrivenSession({
      onEvent: async (e) => {
        if (e.type === "assistant" && e.text === "slow") {
          await slowDone;
          order.push("slow-handler-done");
        } else if (e.type === "result") {
          order.push("result-handler-done");
        }
      },
    });

    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      message: {
        id: "msg_slow",
        role: "assistant",
        content: [{ type: "text", text: "slow" }],
      },
    }));
    feed(ndjson({
      type: "result",
      subtype: "success",
      session_id: "s1",
      result: "done",
      is_error: false,
    }));

    // Race: TurnResult must NOT resolve before the slow handler finishes.
    let turnResolved = false;
    void turnResult.then(() => { turnResolved = true; });

    // Yield a few times — turn must still be pending.
    await new Promise((r) => setTimeout(r, 10));
    expect(turnResolved).toBe(false);

    // Unblock slow handler — chain drains, then turn resolves.
    resolveSlow!();
    await turnResult;
    expect(order).toEqual(["slow-handler-done", "result-handler-done"]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent send — multiple in-flight sends share a TurnResult when the
// CLI coalesces them into a single turn.
// ---------------------------------------------------------------------------

describe("ClaudeSession — concurrent send", () => {
  it("send() while a turn is in progress no longer throws", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    // First send transitions idle → thinking. Second send must not throw.
    const handle1 = await session.send("first message");
    expect(handle1.uuid).toBeTruthy();
    expect(session.state).toBe("thinking");

    // Concurrent — would have thrown under the old guard.
    const handle2 = await session.send("second message during turn");
    expect(handle2.uuid).toBeTruthy();
    expect(handle2.uuid).not.toBe(handle1.uuid);
  });

  it("multiple pending sends share the same TurnResult when the CLI emits one result", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const handle1 = await session.send("first");
    const handle2 = await session.send("second");
    const handle3 = await session.send("third");

    // Three user messages were written to stdin, each with its own uuid.
    const userWrites = stdinWrites.filter((w) => w.includes('"type":"user"'));
    expect(userWrites).toHaveLength(3);
    const writtenUuids = userWrites.map((w) => JSON.parse(w).uuid);
    expect(writtenUuids).toEqual([handle1.uuid, handle2.uuid, handle3.uuid]);

    // Single result event drains all three pending resolvers with the same TurnResult.
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s1",
        result: "coalesced",
        is_error: false,
      }),
    );

    const [r1, r2, r3] = await Promise.all([handle1.result, handle2.result, handle3.result]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1.summary).toBe("coalesced");
  });

  it("attaches the library-generated uuid to the wire user message", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const { uuid } = await session.send("hello");

    // Find the user-message write and verify the uuid matches the handle.
    const userWrite = stdinWrites.find((w) => w.includes('"type":"user"'));
    expect(userWrite).toBeTruthy();
    const parsed = JSON.parse(userWrite!);
    expect(parsed.uuid).toBe(uuid);
    expect(parsed.message.content).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// cancel() — control_request {subtype:'cancel_async_message', message_uuid}
// ---------------------------------------------------------------------------

describe("ClaudeSession — cancel", () => {
  it("builds a cancel_async_message control_request with the given uuid", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const target = "00000000-0000-0000-0000-000000000abc";
    // Fire-and-forget — we'll resolve it via a synthesized control_response.
    const cancelP = session.cancel(target);

    // The most recent write should be the control_request.
    const lastWrite = stdinWrites.at(-1)!;
    const parsed = JSON.parse(lastWrite);
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("cancel_async_message");
    expect(parsed.request.message_uuid).toBe(target);
    expect(typeof parsed.request_id).toBe("string");
    expect(parsed.request_id.length).toBeGreaterThan(0);

    // Feed a matching success control_response.
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: parsed.request_id,
          subtype: "success",
          response: { cancelled: true },
        },
      }),
    );

    const result = await cancelP;
    expect(result.cancelled).toBe(true);
  });

  it("returns {cancelled: false} when the CLI reports nothing to cancel", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const cancelP = session.cancel("unknown-uuid");
    const parsed = JSON.parse(stdinWrites.at(-1)!);

    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: parsed.request_id,
          subtype: "success",
          response: { cancelled: false },
        },
      }),
    );

    expect(await cancelP).toEqual({ cancelled: false });
  });

  it("returns {cancelled: false} when the session is already closed", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);
    // Simulate process exit so state flips to closed.
    proc.emit("exit", 0, null);
    expect(await session.cancel("any-uuid")).toEqual({ cancelled: false });
  });
});

// ---------------------------------------------------------------------------
// stopTask() — control_request {subtype:'stop_task', task_id}
// ---------------------------------------------------------------------------

describe("ClaudeSession — stopTask", () => {
  it("builds a stop_task control_request with the given task_id", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const taskId = "task_abc123";
    const stopP = session.stopTask(taskId);

    const lastWrite = stdinWrites.at(-1)!;
    const parsed = JSON.parse(lastWrite);
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("stop_task");
    expect(parsed.request.task_id).toBe(taskId);
    expect(typeof parsed.request_id).toBe("string");
    expect(parsed.request_id.length).toBeGreaterThan(0);

    // The CLI acknowledges a successful stop with an EMPTY success response.
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      JSON.stringify({
        type: "control_response",
        response: { request_id: parsed.request_id, subtype: "success", response: {} },
      }),
    );

    expect(await stopP).toEqual({ stopped: true });
  });

  it("returns {stopped: false} when the CLI replies with an error (unknown/ended task_id)", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const stopP = session.stopTask("task_unknown");
    const parsed = JSON.parse(stdinWrites.at(-1)!);

    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: parsed.request_id,
          subtype: "error",
          error: "No task with id task_unknown",
        },
      }),
    );

    expect(await stopP).toEqual({ stopped: false });
  });

  it("returns {stopped: false} when the session is already closed (no write)", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);
    proc.emit("exit", 0, null);

    const before = stdinWrites.length;
    expect(await session.stopTask("task_abc")).toEqual({ stopped: false });
    // No control_request should have been written for a closed session.
    expect(stdinWrites.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Per-send timeout / abort (SendOptions)
// ---------------------------------------------------------------------------

function feedLine(session: ClaudeSessionImpl, obj: Record<string, unknown>): void {
  (session as unknown as { handleLine: (l: string) => void }).handleLine(JSON.stringify(obj));
}

describe("ClaudeSession — per-send timeout / abort", () => {
  it("resolves status 'timeout' and writes an interrupt when the deadline fires", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const handle = await session.send("slow task", { timeoutSec: 0.02 });
    const tr = await handle.result;

    expect(tr.status).toBe("timeout");
    expect(tr.errorCode).toBe("timeout");
    expect(tr.errorMessage).toMatch(/timeout/i);
    // The active turn was interrupted via a control_request.
    const interruptWrite = stdinWrites.find((w) => w.includes('"subtype":"interrupt"'));
    expect(interruptWrite).toBeTruthy();
  });

  it("falls back to ProviderConfig.timeoutSec as the session-level default", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { timeoutSec: 0.02 } }, null);

    const handle = await session.send("task");
    const tr = await handle.result;
    expect(tr.status).toBe("timeout");
  });

  it("per-call timeoutSec overrides the session default (0 disables)", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { timeoutSec: 0.02 } }, null);

    const handle = await session.send("task", { timeoutSec: 0 });
    // Real result lands; the disabled per-call timeout must not fire.
    feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false });
    const tr = await handle.result;
    expect(tr.status).toBe("completed");
    expect(stdinWrites.find((w) => w.includes('"subtype":"interrupt"'))).toBeFalsy();
  });

  it("a real result before the timeout wins; no spurious interrupt", async () => {
    const { proc, stdinWrites } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const handle = await session.send("task", { timeoutSec: 100 });
    feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false });

    const tr = await handle.result;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("done");
    expect(stdinWrites.find((w) => w.includes('"subtype":"interrupt"'))).toBeFalsy();
  });

  it("SendOptions.signal abort resolves status 'aborted'", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const ac = new AbortController();
    const handle = await session.send("task", { signal: ac.signal });
    ac.abort();

    const tr = await handle.result;
    expect(tr.status).toBe("aborted");
    expect(tr.errorCode).toBe("aborted");
  });

  it("a pre-aborted signal still settles the send as 'aborted'", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const handle = await session.send("task", { signal: AbortSignal.abort() });
    const tr = await handle.result;
    expect(tr.status).toBe("aborted");
  });

  it("only the timed-out send settles early; a concurrent send still gets the real result", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const slow = await session.send("slow", { timeoutSec: 0.02 });
    const other = await session.send("other"); // no timeout
    const slowResult = await slow.result;
    expect(slowResult.status).toBe("timeout");

    // The shared turn's real result drains the remaining pending send.
    feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false });
    const otherResult = await other.result;
    expect(otherResult.status).toBe("completed");
    expect(otherResult.summary).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// drain() + configurable graceSec
// ---------------------------------------------------------------------------

describe("ClaudeSession — drain + graceSec", () => {
  it("refuses new sends while draining, awaits the in-flight turn, then closes", async () => {
    const { proc } = makeFakeProc();
    // Small grace so close()'s SIGKILL fallback resolves fast (fake proc never exits).
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);

    const handle = await session.send("task");
    const drainP = session.drain();

    await expect(session.send("nope")).rejects.toThrow(/draining/);

    // Complete the in-flight turn — drain can now proceed to close().
    feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false });
    const tr = await handle.result;
    expect(tr.status).toBe("completed");

    await drainP;
    expect(session.state).toBe("closed");
  });

  it("drain() is idempotent", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);
    await Promise.all([session.drain(), session.drain()]);
    expect(session.state).toBe("closed");
  });

  it("close() honors ProviderConfig.graceSec for the SIGKILL fallback", async () => {
    const kills: string[] = [];
    const { proc } = makeFakeProc();
    (proc as unknown as { kill: (s: string) => boolean }).kill = (sig: string) => {
      kills.push(sig);
      return true;
    };
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);

    const start = Date.now();
    await session.close();
    const elapsed = Date.now() - start;

    expect(kills).toContain("SIGTERM");
    expect(kills).toContain("SIGKILL");
    // Without the graceSec wiring this would wait the hardcoded 5s.
    expect(elapsed).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// tool_result.toolName enrichment
// ---------------------------------------------------------------------------

describe("ClaudeSession — tool_result.toolName", () => {
  it("stamps toolName from the preceding tool_call on the same stream", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }],
      },
    }));
    feed(ndjson({
      type: "user",
      session_id: "s1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok", is_error: false }],
      },
    }));
    feed(ndjson({ type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false }));

    await turnResult;
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.toolName).toBe("Bash");
  });

  it("leaves toolName null when no matching tool_call was observed", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    feed(ndjson({
      type: "user",
      session_id: "s1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "x", is_error: false }],
      },
    }));
    feed(ndjson({ type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false }));

    await turnResult;
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.toolName).toBeNull();
  });
});
