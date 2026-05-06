import { describe, it, expect } from "vitest";
import {
  parseClaudeStreamJson,
  toStreamEvents,
  parseStreamLine,
  isClaudeUnknownSessionError,
  isClaudeAuthRequired,
  isClaudeMaxTurns,
} from "../../../src/providers/claude/parse.js";
import {
  CLAUDE_SUCCESS_OUTPUT,
  CLAUDE_MAX_TURNS_OUTPUT,
  CLAUDE_AUTH_REQUIRED_OUTPUT,
  CLAUDE_UNKNOWN_SESSION_OUTPUT,
  CLAUDE_MALFORMED_OUTPUT,
  CLAUDE_TOOL_USE_OUTPUT,
} from "../../fixtures/stream-json-samples.js";

describe("parseClaudeStreamJson", () => {
  it("extracts all fields from success output", () => {
    const result = parseClaudeStreamJson(CLAUDE_SUCCESS_OUTPUT);
    expect(result.sessionId).toBe("sess-abc-123");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.costUsd).toBe(0.0042);
    expect(result.modelUsage).toEqual({
      "claude-sonnet-4-20250514": {
        inputTokens: 150,
        outputTokens: 50,
        cachedInputTokens: 10,
      },
    });
    expect(result.summary).toBe("Task completed successfully.");
    expect(result.isError).toBe(false);
    expect(result.errorCode).toBeNull();
  });

  it("detects max_turns error", () => {
    const result = parseClaudeStreamJson(CLAUDE_MAX_TURNS_OUTPUT);
    expect(result.errorCode).toBe("max_turns");
    expect(result.isError).toBe(true);
    expect(result.sessionId).toBe("sess-max-turns");
  });

  it("skips malformed lines gracefully", () => {
    const result = parseClaudeStreamJson(CLAUDE_MALFORMED_OUTPUT);
    expect(result.sessionId).toBe("sess-malformed");
    expect(result.summary).toBe("Done despite bad lines.");
  });

  it("returns null fields when no result event", () => {
    const result = parseClaudeStreamJson('{"type":"system","subtype":"init","session_id":"s1","model":"m1"}');
    expect(result.modelUsage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.sessionId).toBe("s1");
    expect(result.model).toBe("m1");
  });

  it("handles empty stdout", () => {
    const result = parseClaudeStreamJson("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("extracts provider-reported run metadata (stopReason, terminalReason, numTurns, durationApiMs, permissionDenials)", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" }),
      JSON.stringify({
        type: "result",
        session_id: "s1",
        result: "ok",
        is_error: false,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        num_turns: 3,
        duration_ms: 1200,
        duration_api_ms: 900,
        permission_denials: [{ tool: "Write", reason: "user denied" }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(stdout);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalReason).toBe("completed");
    expect(result.numTurns).toBe(3);
    expect(result.durationApiMs).toBe(900);
    expect(result.permissionDenials).toEqual([{ tool: "Write", reason: "user denied" }]);
    expect(result.finalEvent).toBeDefined();
    expect(result.finalEvent!["result"]).toBe("ok");
  });

  it("collects rate_limit_event signals onto rateLimits", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" }),
      JSON.stringify({
        type: "rate_limit_event",
        session_id: "s1",
        uuid: "rl-1",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1776805200,
          rateLimitType: "five_hour",
          overageStatus: "allowed",
          isUsingOverage: true,
        },
      }),
      JSON.stringify({ type: "result", session_id: "s1", result: "ok", is_error: false }),
    ].join("\n");
    const result = parseClaudeStreamJson(stdout);
    expect(result.rateLimits).toHaveLength(1);
    expect(result.rateLimits[0]).toEqual({
      status: "rejected",
      limitType: "five_hour",
      resetAt: "2026-04-21T21:00:00.000Z",
      overageStatus: "allowed",
      isUsingOverage: true,
    });
  });
});

describe("parseStreamLine", () => {
  it("returns system event from init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-abc-123",
      model: "claude-sonnet-4-20250514",
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("system");
    if (event.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("sess-abc-123");
      expect(event.model).toBe("claude-sonnet-4-20250514");
    }
  });

  it("emits a permission_mode event from a permission-mode line", () => {
    const line = JSON.stringify({
      type: "permission-mode",
      permissionMode: "plan",
      session_id: "sess-plan-1",
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("permission_mode");
    if (event.type === "permission_mode") {
      expect(event.permissionMode).toBe("plan");
      expect(event.sessionId).toBe("sess-plan-1");
      expect(event.providerType).toBe("claude");
    }
  });

  it("skips a permission-mode line with no permissionMode value", () => {
    const line = JSON.stringify({ type: "permission-mode" });
    expect(parseStreamLine(line)).toHaveLength(0);
  });

  it("returns an `unknown` event for non-init system events (forward-compat)", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("unknown");
    if (events[0]!.type === "unknown") {
      expect(events[0]!.subtype).toBe("system");
      expect(events[0]!.raw).toEqual({ type: "system", subtype: "other" });
    }
  });

  it("unknown variant preserves sessionId, eventId, and raw verbatim", () => {
    const rawEvent = {
      type: "compaction_event",
      session_id: "sess-xyz",
      uuid: "event-uuid-999",
      parent_tool_use_id: null,
      some_future_field: { nested: "value" },
    };
    const events = parseStreamLine(JSON.stringify(rawEvent));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("unknown");
    if (events[0]!.type === "unknown") {
      expect(events[0]!.subtype).toBe("compaction_event");
      expect(events[0]!.sessionId).toBe("sess-xyz");
      expect(events[0]!.eventId).toBe("event-uuid-999");
      expect(events[0]!.providerType).toBe("claude");
      expect(events[0]!.raw).toEqual(rawEvent);
    }
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseStreamLine("not json")).toHaveLength(0);
  });

  it("returns multiple events from assistant message with mixed content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll create that file." },
          { type: "tool_use", id: "toolu_write_01", name: "write_file", input: { path: "test.ts" } },
        ],
      },
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("assistant");
    expect(events[1]!.type).toBe("tool_call");
    if (events[1]!.type === "tool_call") {
      expect(events[1]!.name).toBe("write_file");
      expect(events[1]!.toolCallId).toBe("toolu_write_01");
    }
  });

  it("returns callId from tool_use block id field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_abc_999", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    if (events[0]!.type === "tool_call") {
      expect(events[0]!.toolCallId).toBe("toolu_abc_999");
      expect(events[0]!.name).toBe("Bash");
    }
  });

  it("callId is null when tool_use block has no id", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
        ],
      },
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "tool_call") {
      expect(events[0]!.toolCallId).toBeNull();
    }
  });
});

describe("toStreamEvents", () => {
  it("converts success output to stream events", () => {
    const events = toStreamEvents(CLAUDE_SUCCESS_OUTPUT);
    expect(events.length).toBeGreaterThan(0);
    const system = events.find((e) => e.type === "system");
    expect(system).toBeDefined();
    if (system?.type === "system") {
      expect(system.subtype).toBe("init");
      expect(system.sessionId).toBe("sess-abc-123");
      expect(system.model).toBe("claude-sonnet-4-20250514");
    }
    const assistant = events.find((e) => e.type === "assistant");
    expect(assistant).toBeDefined();
    if (assistant?.type === "assistant") {
      expect(assistant.text).toContain("Hello");
    }
    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
  });

  it("extracts tool_call events with callId", () => {
    const events = toStreamEvents(CLAUDE_TOOL_USE_OUTPUT);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("Read");
      expect(toolCall.toolCallId).toBe("toolu_01ABC123");
    }
  });

  it("extracts tool_result events", () => {
    const events = toStreamEvents(CLAUDE_TOOL_USE_OUTPUT);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.toolCallId).toBe("tool-123");
      expect(toolResult.isError).toBe(false);
    }
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects unknown session in stdout", () => {
    expect(isClaudeUnknownSessionError(CLAUDE_UNKNOWN_SESSION_OUTPUT, "")).toBe(true);
  });

  it("detects 'session not found' in stderr", () => {
    expect(isClaudeUnknownSessionError("", "session xyz not found")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isClaudeUnknownSessionError(CLAUDE_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isClaudeAuthRequired", () => {
  it("detects auth required", () => {
    expect(isClaudeAuthRequired(CLAUDE_AUTH_REQUIRED_OUTPUT, "")).toBe(true);
  });

  it("detects login required in stderr", () => {
    expect(isClaudeAuthRequired("", "please log in")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isClaudeAuthRequired(CLAUDE_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isClaudeMaxTurns", () => {
  it("detects max turns", () => {
    expect(isClaudeMaxTurns(CLAUDE_MAX_TURNS_OUTPUT)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isClaudeMaxTurns(CLAUDE_SUCCESS_OUTPUT)).toBe(false);
  });
});
