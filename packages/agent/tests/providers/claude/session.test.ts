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
      _turnResolve: (r: TurnResult) => void;
      _turnReject: (e: Error) => void;
      _state: string;
    })._turnResolve = resolve;
    (session as unknown as { _turnReject: (e: Error) => void })._turnReject = reject;
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
    const turnReject = (session as unknown as {
      _turnReject: (e: Error) => void;
    })._turnReject;
    // Clear _turnResolve so the post-drain code can't double-resolve.
    (session as unknown as { _turnResolve: null })._turnResolve = null;
    turnReject(new Error("simulated exit"));

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
