import { describe, it, expect } from "vitest";
import type { StreamEvent } from "../../src/index.js";
import {
  GOAL_OBJECTIVE_MAX,
  isTerminalGoalStatus,
  normalizeClaudeGoalAttachment,
  normalizeCodexGoalStatus,
  normalizeCodexGoalRecord,
  goalStateFromEvent,
  latestGoalFromEvents,
} from "../../src/index.js";

function baseGoalEvent(over: Partial<Extract<StreamEvent, { type: "goal_status" }>>): Extract<StreamEvent, { type: "goal_status" }> {
  return {
    type: "goal_status",
    objective: "x",
    status: "active",
    met: false,
    enforced: true,
    source: "agentex",
    timestamp: "2026-06-25T00:00:00.000Z",
    providerType: "test",
    sessionId: null,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: {},
    ...over,
  };
}

describe("goal normalization", () => {
  it("exposes the 4000-char objective cap", () => {
    expect(GOAL_OBJECTIVE_MAX).toBe(4000);
  });

  it("isTerminalGoalStatus", () => {
    expect(isTerminalGoalStatus("met")).toBe(true);
    expect(isTerminalGoalStatus("cleared")).toBe(true);
    expect(isTerminalGoalStatus("blocked")).toBe(true);
    expect(isTerminalGoalStatus("active")).toBe(false);
    expect(isTerminalGoalStatus("paused")).toBe(false);
  });

  describe("Claude goal_status attachment", () => {
    it("met:false → active, sentinel-enforced", () => {
      const f = normalizeClaudeGoalAttachment({ type: "goal_status", met: false, sentinel: true, condition: "tests pass" });
      expect(f).toEqual({ objective: "tests pass", status: "active", met: false, enforced: true, source: "sentinel" });
    });

    it("met:true → met", () => {
      const f = normalizeClaudeGoalAttachment({ type: "goal_status", met: true, sentinel: true, condition: "tests pass" });
      expect(f).toMatchObject({ status: "met", met: true, enforced: true, source: "sentinel" });
    });

    it("non-goal attachment → null", () => {
      expect(normalizeClaudeGoalAttachment({ type: "image", url: "x" })).toBeNull();
      expect(normalizeClaudeGoalAttachment(null)).toBeNull();
      expect(normalizeClaudeGoalAttachment(undefined)).toBeNull();
    });

    it("missing condition → empty objective (defensive)", () => {
      const f = normalizeClaudeGoalAttachment({ type: "goal_status", met: false });
      expect(f).toMatchObject({ objective: "", status: "active" });
    });
  });

  describe("Codex status mapping", () => {
    const cases: Array<[string | null | undefined, string, boolean, string | undefined]> = [
      ["active", "active", false, undefined],
      ["pursuing", "active", false, undefined],
      ["paused", "paused", false, undefined],
      ["complete", "met", true, undefined],
      ["completed", "met", true, undefined],
      ["achieved", "met", true, undefined],
      ["budget-limited", "blocked", false, "budget"],
      ["budget_limited", "blocked", false, "budget"],
      ["budgetLimited", "blocked", false, "budget"], // camelCase, lowercased internally
      ["usageLimited", "blocked", false, "budget"],
      ["blocked", "blocked", false, "needs_input"],
      ["cleared", "cleared", false, undefined],
      [null, "active", false, undefined],
      ["weird-unknown", "active", false, undefined],
    ];
    for (const [raw, status, met, blockedReason] of cases) {
      it(`${String(raw)} → ${status}`, () => {
        const out = normalizeCodexGoalStatus(raw);
        expect(out.status).toBe(status);
        expect(out.met).toBe(met);
        expect(out.blockedReason).toBe(blockedReason);
      });
    }
  });

  describe("Codex goal record", () => {
    it("active record from model → advisory, model source, telemetry passthrough", () => {
      const f = normalizeCodexGoalRecord(
        { objective: "ship it", status: "active", tokensUsed: 100, timeUsedSeconds: 5, tokenBudget: 40000 },
        "model",
      );
      expect(f).toMatchObject({
        objective: "ship it",
        status: "active",
        met: false,
        enforced: false,
        source: "model",
        tokensUsed: 100,
        timeUsedSeconds: 5,
        tokenBudget: 40000,
      });
    });

    it("complete from model keeps model source", () => {
      const f = normalizeCodexGoalRecord({ objective: "x", status: "complete" }, "model");
      expect(f).toMatchObject({ status: "met", met: true, source: "model" });
    });

    it("budget-limited is system-sourced regardless of the passed source", () => {
      const f = normalizeCodexGoalRecord({ objective: "x", status: "budget-limited" }, "model");
      expect(f).toMatchObject({ status: "blocked", source: "agentex", blockedReason: "budget" });
    });

    it("snake_case telemetry keys also parse", () => {
      const f = normalizeCodexGoalRecord({ objective: "x", status: "active", tokens_used: 7, time_used_seconds: 2, token_budget: 9 });
      expect(f).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 2, tokenBudget: 9 });
    });

    it("non-object → null", () => {
      expect(normalizeCodexGoalRecord(null)).toBeNull();
    });
  });

  describe("goalStateFromEvent / latestGoalFromEvents", () => {
    it("round-trips fields and stamps updatedAt from the event timestamp", () => {
      const ev = baseGoalEvent({ objective: "g", status: "met", met: true, source: "sentinel", tokensUsed: 5 });
      const state = goalStateFromEvent(ev);
      expect(state).toMatchObject({ objective: "g", status: "met", met: true, source: "sentinel", tokensUsed: 5, updatedAt: "2026-06-25T00:00:00.000Z" });
    });

    it("folds a stream to the most recent goal_status", () => {
      const events: StreamEvent[] = [
        baseGoalEvent({ status: "active", met: false }),
        { type: "assistant", text: "working", timestamp: "", providerType: "test", sessionId: null, messageId: null, eventId: null, turnId: null, parentToolCallId: null, raw: {} },
        baseGoalEvent({ status: "met", met: true, source: "sentinel" }),
      ];
      expect(latestGoalFromEvents(events)?.status).toBe("met");
    });

    it("returns null when no goal_status appears", () => {
      expect(latestGoalFromEvents([])).toBeNull();
    });
  });
});
