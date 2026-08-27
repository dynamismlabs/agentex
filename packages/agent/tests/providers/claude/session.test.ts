import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  ClaudeSessionImpl,
  buildPermissionResponse,
} from "../../../src/providers/claude/session.js";
import { assertSessionRecord } from "../../../src/sessions/index.js";
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
        commandUuid: string;
        resolve: (r: TurnResult) => void;
        reject: (e: Error) => void;
      }>;
      _state: string;
    })._pendingResults.push({ commandUuid: HARNESS_COMMAND_UUID, resolve, reject });
    (session as unknown as { _state: string })._state = "thinking";
    // Emulate the rest of what send() does. A turn is attributed to the host
    // by the command uuid the CLI echoes back, so a harness that only pushes
    // a resolver would make every host turn look provider-initiated.
    (session as unknown as { _outstandingCommands: Set<string> })
      ._outstandingCommands.add(HARNESS_COMMAND_UUID);
  });
  const feed = (line: string): void => {
    (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  };
  return { session, feed, turnResult };
}

/** The command uuid `makeDrivenSession` registers, as `send()` would. */
const HARNESS_COMMAND_UUID = "cmd-harness-0001";

/** The wire line the CLI emits when it begins running a queued host message. */
function commandStarted(uuid = HARNESS_COMMAND_UUID): string {
  return JSON.stringify({
    type: "command_lifecycle", state: "started", command_uuid: uuid, session_id: "s1",
  });
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
    // `turn_start` leads every turn — the stream, not the host's own dispatch,
    // is what says a turn is open. See the turn-liveness tests below.
    // `turn_end` closes every turn — `result` is the payload, not the close.
    expect(seen).toEqual(["turn_start", "assistant:A", "assistant:C", "result", "turn_end"]);
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
    // Call the real exit-handler path rather than re-implementing it. A
    // hand-rolled splice of `_pendingResults` silently stopped covering the
    // case once a settling turn's resolvers moved to their own list, and the
    // awaiting Promise simply hung.
    (session as unknown as { rejectAllPending: (e: Error) => void })
      .rejectAllPending(new Error("simulated exit"));

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

  it("waits for a running subagent and for the resume turn it triggers", async () => {
    // Two gaps, not one. The obvious gap is while the child runs. The subtle
    // one is between its result being delivered and the resume turn opening —
    // measured at 24ms for a subagent, 71ms for a background process. By then
    // the task is no longer live, so waiting on live tasks alone let drain()
    // land in it and SIGTERM the very turn this change exists to protect.
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);

    feedLine(session, {
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "child-1", tool_use_id: "toolu_1", task_type: "subagent",
      description: "research",
    });

    let closed = false;
    const drainP = session.drain().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toBe(false);

    // Result delivered — the task is no longer live, but a turn is coming.
    feedLine(session, {
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "child-1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toBe(false);

    // The resume turn opens and finishes; only now may drain proceed.
    feedLine(session, {
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "the child found 4" }] },
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
    });

    await drainP;
    expect(closed).toBe(true);
    expect(session.state).toBe("closed");
  });

  it("stops waiting when a delivery is folded into the running turn", async () => {
    // Not every delivery starts a turn: one that lands mid-turn is folded into
    // it. That turn's result has to release the wait, or a session would pin
    // itself busy on a resume turn that never comes.
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);

    feedLine(session, {
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "working" }] },
    });
    feedLine(session, {
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "t1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
    });

    await session.drain();
    expect(session.state).toBe("closed");
  });

  it("does not wait for a long-running background process", async () => {
    // A dev server started with run_in_background may never exit. The contract
    // is "let the agent's work settle", not "outlive whatever it launched".
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);

    feedLine(session, {
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "server-1", tool_use_id: "toolu_1", task_type: "local_bash",
      description: "pnpm dev",
    });

    await session.drain();
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

describe("ClaudeSession — describe()", () => {
  function make(ctx: SessionContext) {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, ctx, null);
    const feed = (line: string): void =>
      (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
    return { session, feed };
  }

  it("returns null before Claude assigns a session id", () => {
    const { session } = make({ cwd: "/work" });
    expect(session.describe()).toBeNull();
  });

  it("returns a valid SessionRecord after the session id event", () => {
    const { session, feed } = make({ cwd: "/work" });
    feed(ndjson({
      type: "system",
      subtype: "init",
      session_id: "sess-abc",
      cwd: "/work",
      model: "claude-sonnet",
      tools: [],
      permissionMode: "default",
    }));

    const rec = session.describe();
    expect(rec).not.toBeNull();
    expect(() => assertSessionRecord(rec)).not.toThrow();
    expect(rec!.version).toBe(1);
    expect(rec!.providerType).toBe("claude");
    expect(rec!.params).toMatchObject({ sessionId: "sess-abc", cwd: "/work" });
    expect(rec!.cwd).toBe("/work");
    expect(rec!.displayId).toBe("sess-abc");
    expect(typeof rec!.updatedAt).toBe("string");
  });

  it("records the effective cwd when the caller omitted one", () => {
    const { session, feed } = make({});
    feed(ndjson({ type: "system", subtype: "init", session_id: "s2", model: "m", tools: [], permissionMode: "default" }));
    const rec = session.describe();
    expect(rec!.cwd).toBe(process.cwd());
    expect(rec!.params).toEqual({ sessionId: "s2", cwd: process.cwd() });
  });
});

// ---------------------------------------------------------------------------
// Turn liveness — `turn_start` / `result`
//
// A host cannot derive "is the agent working" from its own dispatch, because
// not every turn is the host's. When a background task finishes, Claude
// enqueues the notification as user input and opens a fresh turn by itself.
// Before `turn_start`, that turn was invisible: `send()` had already resolved,
// so hosts reported the session as finished while it was visibly working.
// ---------------------------------------------------------------------------

/**
 * Build a session with no outstanding send, so turns read as provider-initiated.
 *
 * `flush` awaits the session's internal event chain — onEvent delivery is
 * queued on a promise chain, so a feed is not observable until it drains.
 */
function makeIdleSession(ctx: SessionContext): {
  session: ClaudeSessionImpl;
  feed: (line: string) => void;
  flush: () => Promise<void>;
} {
  const { proc } = makeFakeProc();
  const session = new ClaudeSessionImpl(proc, ctx, null);
  const feed = (line: string): void => {
    (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  };
  const flush = async (): Promise<void> => {
    await (session as unknown as { _eventChain: Promise<void> })._eventChain;
  };
  return { session, feed, flush };
}

describe("ClaudeSession — turn liveness", () => {
  const assistant = (text: string) => ndjson({
    type: "assistant",
    session_id: "s1",
    message: { id: `msg_${text}`, role: "assistant", content: [{ type: "text", text }] },
  });
  const result = () => ndjson({
    type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
  });

  it("marks a turn the host asked for as `send`", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });
    feed(assistant("A"));
    feed(result());
    await turnResult;

    const start = events.find((e) => e.type === "turn_start");
    expect(start).toBeDefined();
    expect(start?.type === "turn_start" && start.trigger).toBe("send");
  });

  it("marks a turn the CLI started by itself as `resume`", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(assistant("self-started"));
    await flush();

    const start = events.find((e) => e.type === "turn_start");
    expect(start?.type === "turn_start" && start.trigger).toBe("resume");
  });

  it("opens exactly one turn no matter how much content follows", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(assistant("A"));
    feed(assistant("B"));
    feed(assistant("C"));
    await flush();
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
  });

  it("opens a second turn after a result closes the first", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(assistant("A"));
    feed(result());
    feed(assistant("B"));
    await flush();

    const kinds = events.map((e) => e.type).filter((t) => t === "turn_start" || t === "result");
    expect(kinds).toEqual(["turn_start", "result", "turn_start"]);
  });

  it("does not open a turn on background-task chatter between turns", async () => {
    // These arrive while nothing is running — a detached child reporting in.
    // Treating one as a turn opening would report the session as working
    // every time a background process coughed.
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({ type: "system", subtype: "background_tasks_changed", session_id: "s1" }));
    feed(ndjson({ type: "system", subtype: "task_updated", session_id: "s1", task_id: "t1", patch: { status: "completed" } }));
    feed(ndjson({
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "t1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    }));
    await flush();
    expect(events.some((e) => e.type === "turn_start")).toBe(false);
  });

  it("does not open a turn for a detached subagent's own output", async () => {
    // Claude streams a subagent's assistant text and tool calls onto the
    // parent stream while the root turn is already over. That is the child
    // working, not this session — counting it would hold the session
    // "working" for the whole detached run, when the honest answer (and what
    // the CLI shows) is that the root turn finished.
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: "toolu_child",
      message: { id: "msg_x", role: "assistant", content: [{ type: "text", text: "exploring" }] },
    }));
    await flush();

    expect(events.some((e) => e.type === "turn_start")).toBe(false);
  });

  it("opens the resume turn once the child's result comes back at root level", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    // Child chatter first — no turn.
    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: "toolu_child",
      message: { id: "msg_x", role: "assistant", content: [{ type: "text", text: "working" }] },
    }));
    // Then the delivery, then the root-level turn it triggers.
    feed(ndjson({
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "ae44620f", tool_use_id: "toolu_child", status: "completed", summary: "12 files",
    }));
    feed(assistant("The subagent counted 12 files."));
    await flush();

    const starts = events.filter((e) => e.type === "turn_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].type === "turn_start" && starts[0].trigger).toBe("resume");
  });

  
  });

// ---------------------------------------------------------------------------
// Background-task identity across a task's lifetime
//
// `task_started` is the only record that names the task's type. The patches
// and the completion notification that follow identify it by id alone, so a
// finished subagent normalized to `taskType: "unknown"` and hosts rendered
// "Background task completed" for what was plainly a subagent.
// ---------------------------------------------------------------------------

describe("ClaudeSession — background task identity", () => {
  const started = () => ndjson({
    type: "system", subtype: "task_started", session_id: "s1",
    task_id: "a4bec5be", tool_use_id: "toolu_1",
    task_type: "subagent", subagent_type: "Explore",
    description: "Find playbank page implementation",
  });
  const completed = () => ndjson({
    type: "system", subtype: "task_notification", session_id: "s1",
    task_id: "a4bec5be", tool_use_id: "toolu_1", status: "completed", summary: "report",
  });

  const tasks = (events: StreamEvent[]) =>
    events.filter((e): e is Extract<StreamEvent, { type: "background_task" }> =>
      e.type === "background_task");

  it("carries the task type from the start event onto the completion", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(started());
    feed(completed());
    await flush();

    const [start, done] = tasks(events);
    expect(start.taskType).toBe("subagent");
    expect(done.taskType).toBe("subagent");
  });

  it("carries the description forward too", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(started());
    feed(completed());
    await flush();

    expect(tasks(events)[1].description).toBe("Find playbank page implementation");
  });

  it("leaves the type unknown when no start event was ever seen", async () => {
    // Honest: a completion for a task this session never saw begin tells us
    // nothing about what it was. Inventing "subagent" would be a guess.
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(completed());
    await flush();

    expect(tasks(events)[0].taskType).toBe("unknown");
  });

  it("does not overwrite a type the later event reported itself", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "t1", task_type: "local_bash", description: "sleep 5",
    }));
    feed(ndjson({
      type: "system", subtype: "task_progress", session_id: "s1",
      task_id: "t1", task_type: "local_bash",
    }));
    await flush();

    const seen = tasks(events);
    expect(seen[0].taskType).toBe("process");
    expect(seen[1].taskType).toBe("process");
  });

  it("keeps separate tasks separate", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(started());
    feed(ndjson({
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "other", task_type: "local_bash", description: "sleep 5",
    }));
    feed(completed());
    await flush();

    const done = tasks(events).find((t) => t.taskId === "a4bec5be" && t.report);
    expect(done?.taskType).toBe("subagent");
    expect(done?.description).toBe("Find playbank page implementation");
  });
});

// ---------------------------------------------------------------------------
// Regressions found by adversarial review of 0.0.37 before release.
// ---------------------------------------------------------------------------

describe("ClaudeSession — turn settling under back-to-back results", () => {
  const result = () => ndjson({
    type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
  });
  const assistant = (text: string) => ndjson({
    type: "assistant",
    session_id: "s1",
    message: { id: `msg_${text}`, role: "assistant", content: [{ type: "text", text }] },
  });

  it("settles the first turn's send when a second result lands mid-drain", async () => {
    // The hang: with a slow (async) onEvent, the resume turn's result is read
    // before the first handleResult resumes from its await. Assigning the
    // settling list there instead of appending discarded the first turn's
    // resolver and `send()` never settled — caller hangs, drain() deadlocks.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let firstResultSeen = false;

    const { feed, turnResult } = makeDrivenSession({
      onEvent: async (e) => {
        if (e.type === "result" && !firstResultSeen) {
          firstResultSeen = true;
          await gate; // hold the chain open across the second result
        }
      },
    });

    feed(assistant("A"));
    feed(result());          // turn 1 — resolvers move to the settling list
    await Promise.resolve(); // let the chain start and block on the gate
    feed(assistant("B"));    // provider-initiated resume turn
    feed(result());          // turn 2 — must NOT clobber turn 1's resolvers
    release!();

    const tr = await turnResult;
    expect(tr.status).toBe("completed");
  });

  it("returns to idle once the last turn's result settles", async () => {
    const { session, feed, turnResult } = makeDrivenSession({});
    feed(assistant("A"));
    feed(result());
    await turnResult;
    expect(session.state).toBe("idle");
  });
});

describe("ClaudeSession — state does not follow a detached child", () => {
  it("stays idle while a subagent streams after the root result", async () => {
    // `turn_start` already ignored nested output; `state` did not, so the two
    // liveness signals contradicted each other for the child's whole run —
    // and nothing clears `state` if the child is stopped or killed.
    const { session, feed, turnResult } = makeDrivenSession({});
    feed(ndjson({
      type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
    }));
    await turnResult;
    expect(session.state).toBe("idle");

    feed(ndjson({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: "toolu_child",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "child working" }] },
    }));
    expect(session.state).toBe("idle");
  });
});

describe("ClaudeSession — turn openers", () => {
  it("ignores system/init before the first result, so boot opens no turn", async () => {
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({ type: "system", subtype: "init", session_id: "s1" }));
    await flush();
    expect(events.some((e) => e.type === "turn_start")).toBe(false);
  });

  it("opens a resume turn on the init that heads it, once a result has been seen", async () => {
    // The CLI re-emits init at the head of every provider-initiated turn, and
    // live it precedes that turn's first assistant line by 1.4-1.9s. Waiting
    // for the assistant line left a blind window on exactly the turns
    // `turn_start` exists to expose.
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({ type: "system", subtype: "init", session_id: "s1" }));
    feed(ndjson({
      type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false,
    }));
    feed(ndjson({ type: "system", subtype: "init", session_id: "s1" }));
    await flush();

    const starts = events.filter((e) => e.type === "turn_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].type === "turn_start" && starts[0].trigger).toBe("resume");
  });

  it("opens the turn on the first partial-message frame, not after the reply", async () => {
    // With includePartialMessages, `stream_event` carries the streamed text.
    // Not matching it meant the whole reply arrived before `turn_start`.
    const events: StreamEvent[] = [];
    const { feed, flush } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({
      type: "stream_event",
      session_id: "s1",
      event: { type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } },
    }));
    await flush();
    expect(events.some((e) => e.type === "turn_start")).toBe(true);
  });
});

describe("ClaudeSession — turn attribution by command identity", () => {
  const assistantLine = (id: string, text: string) => ndjson({
    type: "assistant", session_id: "s1",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });
  const resultLine = () => ndjson({
    type: "result", subtype: "success", session_id: "s1", result: "a", is_error: false,
  });
  const outstandingOf = (session: ClaudeSessionImpl) =>
    (session as unknown as { _outstandingCommands: Set<string> })._outstandingCommands;
  const triggers = (events: StreamEvent[]) =>
    events.filter((e) => e.type === "turn_start")
      .map((e) => (e.type === "turn_start" ? e.trigger : ""));

  it("attributes a turn to the host when the CLI names a command we sent", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    outstandingOf(session).add("cmd-1");
    feed(commandStarted("cmd-1"));
    await flushOfSession(session);
    expect(triggers(events)).toEqual(["send"]);
  });

  it("treats a command we never sent as provider-initiated", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(commandStarted("cmd-someone-else"));
    await flushOfSession(session);
    expect(triggers(events)).toEqual(["resume"]);
  });

  it("labels each of two queued host messages as `send`", async () => {
    // The failure this replaced: a counter emptied at result time reported the
    // second host turn as provider-initiated.
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    outstandingOf(session).add("cmd-1");
    outstandingOf(session).add("cmd-2");

    feed(commandStarted("cmd-1"));
    feed(assistantLine("m1", "one"));
    feed(resultLine());
    feed(commandStarted("cmd-2"));
    feed(assistantLine("m2", "two"));
    await flushOfSession(session);

    expect(triggers(events)).toEqual(["send", "send"]);
  });

  it("falls back to the oldest unclaimed send when the CLI names nothing", async () => {
    // A build that emits no `command_lifecycle` must not report every host
    // turn as provider-initiated.
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    outstandingOf(session).add("cmd-1");
    feed(assistantLine("m1", "hello"));
    await flushOfSession(session);
    expect(triggers(events)).toEqual(["send"]);
  });

  it("does not attribute a background task to a host turn", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    outstandingOf(session).add("cmd-1");
    feed(ndjson({
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "t1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    }));
    feed(commandStarted("cmd-1"));
    await flushOfSession(session);

    const start = events.find((e) => e.type === "turn_start");
    expect(start?.type === "turn_start" && start.trigger).toBe("send");
  });

  
  it("retires a cancelled message so it cannot claim a later turn", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    outstandingOf(session).add("cmd-1");
    feed(ndjson({
      type: "command_lifecycle", state: "cancelled", command_uuid: "cmd-1", session_id: "s1",
    }));
    feed(assistantLine("m1", "a turn the CLI started"));
    await flushOfSession(session);
    expect(triggers(events)).toEqual(["resume"]);
  });

  it("closes a turn that ends in a state producing no result", async () => {
    // `refused`/`discarded` never emit a `result`. Without this the session
    // pins as working forever and drain() blocks behind it.
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    const openTurn = () => (session as unknown as { _openTurn: unknown })._openTurn;
    outstandingOf(session).add("cmd-1");
    feed(commandStarted("cmd-1"));
    expect(openTurn()).not.toBeNull();

    feed(ndjson({
      type: "command_lifecycle", state: "refused", command_uuid: "cmd-1", session_id: "s1",
    }));
    await flushOfSession(session);

    expect(openTurn()).toBeNull();
    expect(session.state).toBe("idle");
  });
});

function flushOfSession(session: ClaudeSessionImpl): Promise<void> {
  return (session as unknown as { _eventChain: Promise<void> })._eventChain;
}

describe("ClaudeSession — fatal teardown resets turn state", () => {
  it("clears the open turn, outstanding sends, live tasks and task facts", () => {
    // These are cleared only on the fatal paths (proc exit / error). A
    // `_turnOpen` left set would also suppress handleResult's idle fallback
    // and pin a dead session as working with no way back.
    // Needs a listener: task-fact tracking runs in the dispatch path, which
    // short-circuits when nothing is subscribed.
    const { session, feed } = makeIdleSession({ onEvent: () => {} });
    const priv = session as unknown as {
      _openTurn: unknown;
      _outstandingCommands: Set<string>;
      _activeTasks: Map<string, unknown>;
      _taskFacts: Map<string, unknown>;
      rejectAllPending: (e: Error) => void;
    };
    feed(ndjson({
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "t1", task_type: "subagent", description: "d",
    }));
    feed(ndjson({
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
    }));
    priv._outstandingCommands.add("cmd-1");
    expect(priv._openTurn).not.toBeNull();
    expect(priv._taskFacts.size).toBe(1);
    expect(priv._activeTasks.size).toBe(1);

    priv.rejectAllPending(new Error("process exited"));

    expect(priv._openTurn).toBeNull();
    expect(priv._outstandingCommands.size).toBe(0);
    expect(priv._activeTasks.size).toBe(0);
    expect(priv._taskFacts.size).toBe(0);
  });
});

describe("ClaudeSession — previously-uncovered guarantees", () => {
  const priv = (session: ClaudeSessionImpl) => session as unknown as {
    _openTurn: unknown;
    _outstandingCommands: Set<string>;
    _activeTasks: Map<string, string>;
    _taskFacts: Map<string, unknown>;
  };

  it("opens the first turn on command_lifecycle, ahead of any content", async () => {
    // Without this opener the session's very first turn had no signal until
    // its first assistant line — measured live at 1.8-6.4s of reading idle
    // while working.
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    priv(session)._outstandingCommands.add("cmd-1");
    feed(commandStarted("cmd-1"));
    await flushOfSession(session);
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
  });

  it("carries the opening line's uuid as the turn_start event id", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    feed(ndjson({
      type: "assistant", session_id: "s1", uuid: "line-uuid-1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
    }));
    await flushOfSession(session);
    const start = events.find((e) => e.type === "turn_start");
    expect(start?.eventId).toBe("line-uuid-1");
  });

  it("keeps turn_start.raw small instead of echoing a 5KB init payload", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    priv(session)._outstandingCommands.add("cmd-1");
    feed(JSON.stringify({
      type: "command_lifecycle", state: "started", command_uuid: "cmd-1", session_id: "s1",
      tools: new Array(200).fill("a-tool-name"),
      slash_commands: new Array(200).fill("a-command"),
    }));
    await flushOfSession(session);
    const start = events.find((e) => e.type === "turn_start");
    expect(JSON.stringify(start?.raw).length).toBeLessThan(120);
  });

  it("sets thinking when a provider-initiated turn opens", () => {
    const { session, feed } = makeIdleSession({});
    expect(session.state).toBe("idle");
    feed(ndjson({
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
    }));
    expect(session.state).toBe("thinking");
  });

  it("does not let a detached child's permission prompt block the session", () => {
    // The child is blocked, not this session. Parking the parent in
    // waiting_for_approval outlived the root turn with nothing to clear it.
    const { session, feed } = makeIdleSession({});
    feed(JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      parent_tool_use_id: "toolu_child",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
    }));
    expect(session.state).not.toBe("waiting_for_approval");
  });

  it("bounds the task-fact cache and evicts oldest-first", () => {
    const { session, feed } = makeIdleSession({ onEvent: () => {} });
    for (let i = 0; i < 600; i++) {
      feed(ndjson({
        type: "system", subtype: "task_started", session_id: "s1",
        task_id: `t${i}`, task_type: "subagent", description: "d",
      }));
    }
    const facts = priv(session)._taskFacts;
    expect(facts.size).toBe(512);
    expect(facts.has("t0")).toBe(false);     // oldest evicted
    expect(facts.has("t599")).toBe(true);    // newest kept
  });

  it("tracks live tasks without needing an event subscriber", () => {
    // `drain()` and `state` read this. Gating it on a listener meant a host
    // that only reads the session silently got degraded behavior.
    const { session, feed } = makeIdleSession({});
    feed(ndjson({
      type: "system", subtype: "task_started", session_id: "s1",
      task_id: "t1", task_type: "subagent", description: "d",
    }));
    expect(priv(session)._activeTasks.get("t1")).toBe("subagent");
    feed(ndjson({
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "t1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    }));
    expect(priv(session)._activeTasks.has("t1")).toBe(false);
  });

  it("ignores wire lines that arrive after close", async () => {
    const { session, feed } = makeIdleSession({});
    await session.close();
    feed(ndjson({
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "late" }] },
    }));
    expect(session.state).toBe("closed");
    expect(priv(session)._openTurn).toBeNull();
  });
});

describe("ClaudeSession — a send resolves with its own turn", () => {
  const outstandingOf = (session: ClaudeSessionImpl) =>
    (session as unknown as { _outstandingCommands: Set<string> })._outstandingCommands;

  it("does not resolve a queued follow-up with another turn's result", async () => {
    // The original bug by a different route: a follow-up the CLI has merely
    // queued was resolved by whichever `result` landed next, so the host read
    // "finished" for a message that had not run.
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    const first = await session.send("one");
    const second = await session.send("two");

    let secondSettled = false;
    void second.result.then(() => { secondSettled = true; }, () => { secondSettled = true; });

    // The CLI runs only the first message's turn.
    feedLine(session, {
      type: "command_lifecycle", state: "started", command_uuid: first.uuid, session_id: "s1",
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "one done", is_error: false,
    });

    const firstResult = await first.result;
    expect(firstResult.summary).toBe("one done");
    await new Promise((r) => setTimeout(r, 20));
    expect(secondSettled).toBe(false);

    // Its own turn arrives and settles it.
    feedLine(session, {
      type: "command_lifecycle", state: "started", command_uuid: second.uuid, session_id: "s1",
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "two done", is_error: false,
    });
    expect((await second.result).summary).toBe("two done");
  });

  it("settles a message the CLI retires without running it", async () => {
    // `cancelled`/`discarded`/`refused` produce no `result`, so nothing else
    // would ever settle the caller.
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);
    const handle = await session.send("never runs");

    feedLine(session, {
      type: "command_lifecycle", state: "cancelled", command_uuid: handle.uuid, session_id: "s1",
    });

    const tr = await handle.result;
    expect(tr.status).toBe("aborted");
    expect(tr.errorCode).toBe("command_cancelled");
    expect(outstandingOf(session).has(handle.uuid)).toBe(false);
  });

  it("does not let a resume turn settle a waiting host message", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);

    // Establish that this build names its commands, so an unnamed turn is
    // known to be provider-initiated rather than assumed to be ours.
    const primer = await session.send("primer");
    feedLine(session, {
      type: "command_lifecycle", state: "started", command_uuid: primer.uuid, session_id: "s1",
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "primed", is_error: false,
    });
    await primer.result;

    const handle = await session.send("queued behind a resume");
    let settled = false;
    void handle.result.then(() => { settled = true; }, () => { settled = true; });

    // A provider-initiated turn runs and completes; it claimed no command.
    feedLine(session, {
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "resume work" }] },
    });
    feedLine(session, {
      type: "result", subtype: "success", session_id: "s1", result: "resume done", is_error: false,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });
});

describe("ClaudeSession — command-naming capability latch", () => {
  it("stops guessing once the CLI has proven it names commands", async () => {
    // The guess mislabels twice when it fires: the resume turn becomes `send`
    // and the real host turn later becomes `resume`, because the uuid is gone.
    const events: StreamEvent[] = [];
    const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
    const outstanding = (session as unknown as { _outstandingCommands: Set<string> })
      ._outstandingCommands;

    // The build names commands — observed here.
    outstanding.add("cmd-1");
    feed(commandStarted("cmd-1"));
    feed(ndjson({
      type: "result", subtype: "success", session_id: "s1", result: "a", is_error: false,
    }));

    // A later unnamed turn must not consume the next queued message.
    outstanding.add("cmd-2");
    feed(ndjson({
      type: "assistant", session_id: "s1",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "resume" }] },
    }));
    await flushOfSession(session);

    const triggers = events.filter((e) => e.type === "turn_start")
      .map((e) => (e.type === "turn_start" ? e.trigger : ""));
    expect(triggers).toEqual(["send", "resume"]);
    expect(outstanding.has("cmd-2")).toBe(true);
  });
});

describe("ClaudeSession — a turn that ends without a result releases the wait", () => {
  it("does not pin drain() when the CLI refuses the message", async () => {
    // `refused`/`discarded` produce no `result`, so the result path cannot be
    // what releases a pending resume-turn wait here.
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, { config: { graceSec: 0.02 } }, null);
    const handle = await session.send("will be refused");

    feedLine(session, {
      type: "system", subtype: "task_notification", session_id: "s1",
      task_id: "t1", tool_use_id: "toolu_1", status: "completed", summary: "done",
    });
    feedLine(session, {
      type: "command_lifecycle", state: "started", command_uuid: handle.uuid, session_id: "s1",
    });
    feedLine(session, {
      type: "command_lifecycle", state: "refused", command_uuid: handle.uuid, session_id: "s1",
    });

    await session.drain();
    expect(session.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// State-machine invariants.
//
// Distinct from the regression tests above, which each pin one past bug. These
// assert properties that must hold across permutations of the wire, because a
// suite of per-bug tests passed while two races were live.
// ---------------------------------------------------------------------------

describe("ClaudeSession — turn invariants under permutation", () => {
  const kinds = (events: StreamEvent[], t: string) => events.filter((e) => e.type === t);

  /** Every turn_start is matched by exactly one turn_end with the same id. */
  function expectBalanced(events: StreamEvent[]) {
    const starts = kinds(events, "turn_start").map((e) => (e as { turnId: string }).turnId);
    const ends = kinds(events, "turn_end").map((e) => (e as { turnId: string }).turnId);
    expect(ends).toEqual(starts);
    expect(new Set(starts).size).toBe(starts.length);
  }

  const assistantLine = (id: string) => ndjson({
    type: "assistant", session_id: "s1",
    message: { id, role: "assistant", content: [{ type: "text", text: id }] },
  });
  const resultLine = () => ndjson({
    type: "result", subtype: "success", session_id: "s1", result: "r", is_error: false,
  });
  const lifecycle = (state: string, uuid: string) => ndjson({
    type: "command_lifecycle", state, command_uuid: uuid, session_id: "s1",
  });
  const notify = (taskId: string) => ndjson({
    type: "system", subtype: "task_notification", session_id: "s1",
    task_id: taskId, tool_use_id: `toolu_${taskId}`, status: "completed", summary: "done",
  });

  const SEQUENCES: Array<[string, string[]]> = [
    ["host turn", [lifecycle("started", "c1"), assistantLine("a"), resultLine(), lifecycle("completed", "c1")]],
    ["resume turn", [notify("t1"), assistantLine("a"), resultLine()]],
    ["host then resume", [lifecycle("started", "c1"), resultLine(), lifecycle("completed", "c1"), notify("t1"), assistantLine("b"), resultLine()]],
    ["coalesced sends", [lifecycle("started", "c1"), lifecycle("started", "c2"), assistantLine("a"), resultLine(), lifecycle("completed", "c1"), lifecycle("completed", "c2")]],
    ["refused message", [lifecycle("started", "c1"), lifecycle("refused", "c1")]],
    ["cancelled before start", [lifecycle("cancelled", "c1"), assistantLine("a"), resultLine()]],
    ["back-to-back results", [assistantLine("a"), resultLine(), assistantLine("b"), resultLine()]],
    ["delivery mid-turn", [assistantLine("a"), notify("t1"), resultLine()]],
    ["two deliveries", [notify("t1"), notify("t2"), assistantLine("a"), resultLine()]],
    ["result with no opener", [resultLine()]],
    ["init before any result", [ndjson({ type: "system", subtype: "init", session_id: "s1" })]],
  ];

  for (const [name, lines] of SEQUENCES) {
    it(`balances turn_start/turn_end: ${name}`, async () => {
      const events: StreamEvent[] = [];
      const { session, feed } = makeIdleSession({ onEvent: (e) => { events.push(e); } });
      (session as unknown as { _outstandingCommands: Set<string> })
        ._outstandingCommands.add("c1");
      (session as unknown as { _outstandingCommands: Set<string> })
        ._outstandingCommands.add("c2");
      for (const line of lines) feed(line);
      await flushOfSession(session);
      expectBalanced(events);
    });

    it(`leaves no turn open at rest: ${name}`, async () => {
      const { session, feed } = makeIdleSession({ onEvent: () => {} });
      for (const line of lines) feed(line);
      await flushOfSession(session);
      // Every sequence here ends with the turn closed: each either reaches a
      // `result` or is retired by a terminal lifecycle record, and `init`
      // before the first result opens no turn at all.
      expect((session as unknown as { _openTurn: unknown })._openTurn).toBeNull();
    });
  }

  it("never resolves a send with another turn's result, across orderings", async () => {
    // The race that a suite of per-bug tests missed: two results read while
    // the first handler is still suspended.
    for (const delayFirst of [true, false]) {
      let release: (() => void) | null = null;
      const gate = new Promise<void>((r) => { release = r; });
      let seen = 0;
      const { proc } = makeFakeProc();
      const session = new ClaudeSessionImpl(proc, {
        onEvent: async (e) => {
          if (e.type === "result" && ++seen === 1 && delayFirst) await gate;
        },
      }, null);

      const a = await session.send("one");
      const b = await session.send("two");
      feedLine(session, { type: "command_lifecycle", state: "started", command_uuid: a.uuid, session_id: "s1" });
      feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "ONE", is_error: false });
      feedLine(session, { type: "command_lifecycle", state: "started", command_uuid: b.uuid, session_id: "s1" });
      feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "TWO", is_error: false });
      release!();

      expect([(await a.result).summary, (await b.result).summary]).toEqual(["ONE", "TWO"]);
    }
  });

  it("settles every send exactly once, whatever the CLI does with it", async () => {
    const { proc } = makeFakeProc();
    const session = new ClaudeSessionImpl(proc, {}, null);
    const ran = await session.send("runs");
    const coalesced = await session.send("coalesced");
    const refused = await session.send("refused");

    const counts = new Map<string, number>();
    for (const [name, h] of [["ran", ran], ["coalesced", coalesced], ["refused", refused]] as const) {
      void h.result.then(
        () => counts.set(name, (counts.get(name) ?? 0) + 1),
        () => counts.set(name, (counts.get(name) ?? 0) + 1),
      );
    }

    feedLine(session, { type: "command_lifecycle", state: "started", command_uuid: ran.uuid, session_id: "s1" });
    feedLine(session, { type: "command_lifecycle", state: "started", command_uuid: coalesced.uuid, session_id: "s1" });
    feedLine(session, { type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false });
    feedLine(session, { type: "command_lifecycle", state: "refused", command_uuid: refused.uuid, session_id: "s1" });

    await Promise.all([ran.result, coalesced.result, refused.result]);
    await new Promise((r) => setTimeout(r, 20));
    expect([...counts.entries()].sort()).toEqual([["coalesced", 1], ["ran", 1], ["refused", 1]]);
  });
});
