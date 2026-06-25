import { describe, it, expect } from "vitest";
import { parseCodexStreamLine } from "../../../src/providers/codex/parse.js";

describe("codex parse — goal lifecycle", () => {
  describe("v2 JSON-RPC notifications", () => {
    it("thread/goal/updated active → advisory goal_status with telemetry + thread scope", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: { threadId: "thr-1", goal: { objective: "ship auth", status: "active", tokensUsed: 120, timeUsedSeconds: 8, tokenBudget: 40000 } },
      });
      const ev = parseCodexStreamLine(line);
      expect(ev).toMatchObject({
        type: "goal_status",
        objective: "ship auth",
        status: "active",
        met: false,
        enforced: false,
        source: "model",
        tokensUsed: 120,
        timeUsedSeconds: 8,
        tokenBudget: 40000,
        sessionId: "thr-1",
        providerType: "codex",
      });
    });

    it("complete → met", () => {
      const line = JSON.stringify({ jsonrpc: "2.0", method: "thread/goal/updated", params: { threadId: "t", goal: { objective: "x", status: "complete" } } });
      expect(parseCodexStreamLine(line)).toMatchObject({ type: "goal_status", status: "met", met: true, source: "model" });
    });

    it("budget-limited → blocked (system-sourced)", () => {
      const line = JSON.stringify({ jsonrpc: "2.0", method: "thread/goal/updated", params: { goal: { objective: "x", status: "budget-limited" } } });
      expect(parseCodexStreamLine(line)).toMatchObject({ type: "goal_status", status: "blocked", blockedReason: "budget", source: "agentex" });
    });

    it("thread/goal/cleared → cleared", () => {
      const line = JSON.stringify({ jsonrpc: "2.0", method: "thread/goal/cleared", params: { goal: { objective: "x" } } });
      expect(parseCodexStreamLine(line)).toMatchObject({ type: "goal_status", status: "cleared", met: false });
    });

    it("thread/goal/cleared with only threadId (no goal) → cleared with empty objective", () => {
      // The schema may omit the goal on clear; the parser stays lenient and the
      // GoalController preserves the prior objective when it observes this.
      const line = JSON.stringify({ jsonrpc: "2.0", method: "thread/goal/cleared", params: { threadId: "t" } });
      expect(parseCodexStreamLine(line)).toMatchObject({ type: "goal_status", status: "cleared", objective: "" });
    });
  });

  describe("NDJSON / event_msg forms", () => {
    it("event_msg wrapper with thread_goal_updated", () => {
      const line = JSON.stringify({ type: "event_msg", payload: { type: "thread_goal_updated", threadId: "thr-9", goal: { objective: "x", status: "complete" } } });
      expect(parseCodexStreamLine(line, "fallback")).toMatchObject({ type: "goal_status", status: "met", met: true, sessionId: "thr-9" });
    });

    it("bare thread_goal_updated with thread_id, falling back to caller sessionId", () => {
      const line = JSON.stringify({ type: "thread_goal_updated", goal: { objective: "x", status: "active" } });
      expect(parseCodexStreamLine(line, "caller-thread")).toMatchObject({ type: "goal_status", status: "active", sessionId: "caller-thread" });
    });
  });

  describe("goal tools remain ordinary tool events (not hijacked into goal_status)", () => {
    it("update_goal function_call → tool_call", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "item/started",
        params: { item: { id: "item_3", type: "function_call", name: "update_goal", arguments: "{\"status\":\"complete\"}" } },
      });
      const ev = parseCodexStreamLine(line);
      expect(ev).toMatchObject({ type: "tool_call", name: "update_goal" });
    });

    it("get_goal function_call output → tool_result", () => {
      const line = JSON.stringify({
        type: "item.completed",
        item: { id: "item_4", type: "function_call", name: "get_goal", output: "{\"goal\":{\"status\":\"active\"}}" },
      });
      const ev = parseCodexStreamLine(line, "t");
      expect(ev).toMatchObject({ type: "tool_result", toolName: "get_goal" });
    });
  });
});
