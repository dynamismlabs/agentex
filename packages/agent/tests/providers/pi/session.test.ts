import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PiSession } from "../../../src/providers/pi/session.js";
import { getProvider } from "../../../src/index.js";
import type { SessionContext, StreamEvent } from "../../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PI_BIN = path.resolve(__dirname, "../../../node_modules/.bin/pi");

function makeFakeProc(): { proc: import("node:child_process").ChildProcess; writes: string[] } {
  const writes: string[] = [];
  const stdin = { write: (c: string) => (writes.push(c), true), destroyed: false };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const proc = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true, killed: false });
  return { proc, writes };
}

/** Construct a PiSession with a fake (un-spawned) process attached. */
function makeSession(ctx: SessionContext): {
  session: PiSession;
  writes: string[];
  feed: (obj: Record<string, unknown>) => void;
} {
  const session = new PiSession(ctx);
  const { proc, writes } = makeFakeProc();
  (session as unknown as { proc: unknown })["proc"] = proc;
  const feed = (obj: Record<string, unknown>): void => {
    (session as unknown as { onStdout: (c: string) => void }).onStdout(JSON.stringify(obj) + "\n");
  };
  return { session, writes, feed };
}

describe("PiSession — persistent RPC turns", () => {
  it("sends a prompt command and resolves on agent_end with accumulated text", async () => {
    const events: StreamEvent[] = [];
    const { session, writes, feed } = makeSession({ onEvent: (e) => events.push(e) });

    const handle = await session.send("hello pi");
    // The prompt was framed as a JSONL prompt command with id + message.
    const cmd = JSON.parse(writes[0]!.trim());
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe("hello pi");
    expect(cmd.id).toBe(handle.uuid);

    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
    feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });
    feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "files" });
    feed({ type: "agent_end" });

    const turn = await handle.result;
    expect(turn.status).toBe("completed");
    expect(turn.summary).toBe("Hello world");
    expect(events.filter((e) => e.type === "assistant")).toHaveLength(2);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.content).toBe("files");
    expect(session.state).toBe("idle");
  });

  it("supports sequential turns on the same process, resetting summary", async () => {
    const { session, feed } = makeSession({});
    const h1 = await session.send("turn 1");
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
    feed({ type: "agent_end" });
    expect((await h1.result).summary).toBe("first");

    const h2 = await session.send("turn 2");
    feed({ type: "agent_end" });
    const r2 = await h2.result;
    expect(r2.status).toBe("completed");
    expect(r2.summary).toBeNull(); // no inherited text
  });

  it("rejects concurrent sends (one turn at a time)", async () => {
    const { session } = makeSession({});
    const h1 = await session.send("busy");
    await expect(session.send("again")).rejects.toThrow(/busy|concurrentSend/i);
    // finish the first turn
    (session as unknown as { onStdout: (c: string) => void }).onStdout(
      JSON.stringify({ type: "agent_end" }) + "\n",
    );
    await h1.result;
  });

  it("resolves status 'timeout' and sends an abort when the deadline fires (ack path)", async () => {
    const { session, writes, feed } = makeSession({});
    const handle = await session.send("slow", { timeoutSec: 0.02 });
    // Let the deadline fire (onTurnInterrupt sends `abort`), then have pi ack with
    // agent_end so the turn resolves promptly rather than waiting out the grace.
    await new Promise((r) => setTimeout(r, 40));
    expect(writes.some((w) => w.includes('"abort"'))).toBe(true);
    feed({ type: "agent_end" });
    const turn = await handle.result;
    expect(turn.status).toBe("timeout");
    expect(turn.errorCode).toBe("timeout");
  });

  it("resolves status 'aborted' when a SendOptions.signal aborts", async () => {
    const { session, feed } = makeSession({});
    const ac = new AbortController();
    const handle = await session.send("task", { signal: ac.signal });
    ac.abort(); // sends `abort` and waits for pi's ack
    feed({ type: "agent_end" });
    expect((await handle.result).status).toBe("aborted");
  });

  it("does not let a timed-out turn's late events contaminate the next turn", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeSession({ onEvent: (e) => events.push(e) });

    // Turn 1 times out; pi keeps streaming turn-1 stragglers, then acks the abort.
    const h1 = await session.send("turn 1", { timeoutSec: 0.02 });
    await new Promise((r) => setTimeout(r, 40));
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "LEAK1" } });
    feed({ type: "agent_end" });
    expect((await h1.result).status).toBe("timeout");

    // A straggler arriving between turns must be dropped, not attributed to turn 2.
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "BETWEEN" } });

    // Turn 2 runs clean.
    const h2 = await session.send("turn 2");
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "clean2" } });
    feed({ type: "agent_end" });
    const r2 = await h2.result;
    expect(r2.status).toBe("completed");
    expect(r2.summary).toBe("clean2");
  });

  it("ignores command-ack responses (not agent events)", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeSession({ onEvent: (e) => events.push(e) });
    const handle = await session.send("hi");
    feed({ id: "x", type: "response", command: "prompt", success: true });
    feed({ type: "agent_end" });
    await handle.result;
    expect(events.every((e) => e.type !== "unknown" || e.subtype !== "response")).toBe(true);
  });
});

describe("pi provider — capabilities", () => {
  it("declares session capabilities", () => {
    const p = getProvider("pi");
    expect(p.capabilities.sessions).toBe(true);
    expect(p.createSession).toBeDefined();
    expect(p.capabilities.concurrentSend).toBe(false);
  });

  // Real-binary turn — opt in with AGENTEX_REAL_PI=1 (needs an authed/configured pi).
  it.skipIf(process.env.AGENTEX_REAL_PI !== "1")(
    "runs a real `pi --mode rpc` turn",
    async () => {
      const session = await getProvider("pi").createSession!({
        config: { command: PI_BIN, timeoutSec: 60 },
      });
      const turn = await (await session.send("Reply with the single word: pong")).result;
      await session.close();
      expect(["completed", "failed", "timeout"]).toContain(turn.status);
      expect(session.state).toBe("closed");
    },
    90_000,
  );
});
