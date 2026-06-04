import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acpProvider } from "../../../src/index.js";
import type { StreamEvent, UserInputRequest } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(__dirname, "../../fixtures/mock-acp-agent.mjs");

function makeProvider() {
  return acpProvider({ id: "mock-acp", command: ["node", MOCK] });
}

describe("acpProvider — session (end-to-end against a mock ACP agent)", () => {
  it("runs a turn: streams assistant/thinking/tool events and completes", async () => {
    const provider = makeProvider();
    const events: StreamEvent[] = [];
    const session = await provider.createSession!({ onEvent: (e) => events.push(e) });

    const handle = await session.send("hello");
    const turn = await handle.result;

    expect(turn.status).toBe("completed");
    expect(turn.summary).toContain("Hello from mock");
    expect(events.some((e) => e.type === "assistant")).toBe(true);
    expect(events.some((e) => e.type === "thinking")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult?.type === "tool_result" && toolResult.content).toBe("file contents");
    expect(session.sessionId).toBeTruthy();

    await session.close();
    expect(session.state).toBe("closed");
  }, 20_000);

  it("bridges requestPermission to onUserInputRequest (allow → agent applies)", async () => {
    const provider = makeProvider();
    const calls: UserInputRequest[] = [];
    const events: StreamEvent[] = [];
    const session = await provider.createSession!({
      onEvent: (e) => events.push(e),
      onUserInputRequest: async (req) => {
        calls.push(req);
        return { allow: true };
      },
    });

    const turn = await (await session.send("ask-permission please")).result;
    expect(turn.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("edit config");
    expect(calls[0]!.toolUseId).toBe("tc2");
    expect(events.some((e) => e.type === "assistant" && e.text === "applied")).toBe(true);
    await session.close();
  }, 20_000);

  it("denying a permission makes the agent skip", async () => {
    const provider = makeProvider();
    const events: StreamEvent[] = [];
    const session = await provider.createSession!({
      onEvent: (e) => events.push(e),
      onUserInputRequest: async () => ({ allow: false }),
    });
    const turn = await (await session.send("ask-permission")).result;
    expect(turn.status).toBe("completed");
    expect(events.some((e) => e.type === "assistant" && e.text === "skipped")).toBe(true);
    await session.close();
  }, 20_000);

  it("maps a refusal stopReason to failed", async () => {
    const provider = makeProvider();
    const session = await provider.createSession!({});
    const turn = await (await session.send("please refuse")).result;
    expect(turn.status).toBe("failed");
    await session.close();
  }, 20_000);

  it("discovers modes via listModes()", async () => {
    const provider = makeProvider();
    const modes = await provider.listModes!();
    expect(modes.map((m) => m.id)).toEqual(["default", "plan"]);
    expect(modes[1]!.description).toBe("Read-only planning");
  }, 20_000);

  it("execute() one-shot returns a completed ExecutionResult", async () => {
    const provider = makeProvider();
    const result = await provider.execute({ prompt: "hi" });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Hello from mock");
    expect(result.exitCode).toBe(0);
    expect(result.sessionDisplayId).toBeTruthy();
  }, 20_000);

  it("rejects concurrent sends (ACP runs one turn at a time)", async () => {
    const provider = makeProvider();
    const session = await provider.createSession!({});
    const h1 = await session.send("hello");
    await expect(session.send("again")).rejects.toThrow(/busy|concurrentSend/i);
    await h1.result;
    await session.close();
  }, 20_000);

  it("resumes via loadSession (sessionParams) when the agent advertises loadSession", async () => {
    const provider = makeProvider();
    const session = await provider.createSession!({ sessionParams: { sessionId: "prev-123" } });
    // Resumed: keeps the prior id rather than minting a fresh one from newSession.
    expect(session.sessionId).toBe("prev-123");
    // And a turn still works on the resumed session.
    const turn = await (await session.send("hello")).result;
    expect(turn.status).toBe("completed");
    await session.close();
  }, 20_000);

  it("a timed-out turn's late chunks don't contaminate the next turn", async () => {
    const provider = makeProvider();
    const session = await provider.createSession!({});
    // Turn 1 times out at 100ms; the mock emits a LATE chunk ~300ms then resolves
    // cancelled. The drain keeps that straggler inside turn 1.
    const t1 = await (await session.send("slow-leak", { timeoutSec: 0.1 })).result;
    expect(t1.status).toBe("timeout");

    // Turn 2 runs clean — its summary must not include turn 1's late "LATE1".
    const t2 = await (await session.send("hello")).result;
    expect(t2.status).toBe("completed");
    expect(t2.summary).toContain("Hello from mock");
    expect(t2.summary).not.toContain("LATE1");
    await session.close();
  }, 20_000);

  it("declares ACP capabilities (sessions, modes, dynamicCapabilities)", () => {
    const caps = makeProvider().capabilities;
    expect(caps.sessions).toBe(true);
    expect(caps.modes).toBe(true);
    expect(caps.dynamicCapabilities).toBe(true);
    expect(caps.concurrentSend).toBe(false);
  });
});

describe("acpProvider — transformers (per-agent quirks)", () => {
  it("modes transformer rewrites the discovered mode list", async () => {
    const provider = acpProvider({
      id: "mock-acp-t",
      command: ["node", MOCK],
      transformers: {
        modes: (modes) => modes.filter((m) => m.id !== "plan").concat({ id: "allow-all", name: "Allow All" }),
      },
    });
    const modes = await provider.listModes!();
    expect(modes.map((m) => m.id)).toEqual(["default", "allow-all"]);
  }, 20_000);

  it("modeId transformer remaps the applied mode before setSessionMode", async () => {
    const provider = acpProvider({
      id: "mock-acp-t2",
      command: ["node", MOCK],
      transformers: { modeId: (id) => (id === "raw" ? "plan" : id) },
    });
    const session = await provider.createSession!({ config: { modeId: "raw" } });
    const turn = await (await session.send("hello")).result;
    // The mock echoes the mode it was actually set to in its first chunk.
    expect(turn.summary).toContain("mode=plan");
    await session.close();
  }, 20_000);
});
