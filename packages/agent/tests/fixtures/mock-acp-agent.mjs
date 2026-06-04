#!/usr/bin/env node
// A deterministic mock ACP *agent* (the agent side of the Agent Client
// Protocol), built on the real @agentclientprotocol/sdk AgentSideConnection so
// agentex's ACP client can be tested end-to-end without a real coding agent.
//
// Prompt-text triggers:
//   "ask-permission" → emits a permission request before finishing
//   "refuse"         → returns stopReason "refusal"
//   (otherwise)      → returns stopReason "end_turn"
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class MockAgent {
  constructor(connection) {
    this.connection = connection;
    this.pending = new Map();
    this.lastModeId = null;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    };
  }

  async loadSession(params) {
    // Resume an existing session id — the client keeps using params.sessionId.
    this.loadedSessionId = params.sessionId;
    return {};
  }

  async newSession() {
    const sessionId = "sess-" + Math.random().toString(16).slice(2, 10);
    return {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default", description: "Normal mode" },
          { id: "plan", name: "Plan", description: "Read-only planning" },
        ],
      },
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode(params) {
    this.lastModeId = params.modeId;
    return {};
  }

  async cancel(params) {
    this.pending.get(params.sessionId)?.abort();
  }

  async prompt(params) {
    const sessionId = params.sessionId;
    const text = (params.prompt ?? []).map((p) => (p && p.type === "text" ? p.text : "")).join(" ");
    const ac = new AbortController();
    this.pending.set(sessionId, ac);

    // "slow-leak": emit an early chunk, stall long enough for the client to time
    // out and cancel, then flush a LATE straggler before resolving cancelled —
    // exercises the client's turn-isolation (the late chunk must not bleed into
    // the next turn).
    if (text.includes("slow-leak")) {
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "EARLY1 " } },
      });
      await new Promise((r) => setTimeout(r, 300));
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE1" } },
      });
      this.pending.delete(sessionId);
      return { stopReason: ac.signal.aborted ? "cancelled" : "end_turn" };
    }

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[mode=${this.lastModeId ?? "none"}] Hello from mock. ` },
      },
    });
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
    });
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "read file",
        kind: "read",
        status: "pending",
        rawInput: { path: "/x" },
      },
    });
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
        rawOutput: { content: "file contents" },
      },
    });

    if (text.includes("ask-permission")) {
      const resp = await this.connection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: "tc2",
          title: "edit config",
          kind: "edit",
          status: "pending",
          rawInput: { path: "/cfg", content: "x" },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      if (resp.outcome.outcome === "cancelled") {
        this.pending.delete(sessionId);
        return { stopReason: "cancelled" };
      }
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: resp.outcome.optionId === "allow" ? "applied" : "skipped" },
        },
      });
    }

    this.pending.delete(sessionId);
    if (text.includes("refuse")) return { stopReason: "refusal" };
    return { stopReason: "end_turn" };
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new MockAgent(conn), stream);
