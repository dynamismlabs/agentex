import { describe, it, expect } from "vitest";
import {
  parseClaudeStreamJson,
  toStreamEvents,
  parseStreamLine,
  isClaudeUnknownSessionError,
  isClaudeAuthRequired,
  isClaudeMaxTurns,
} from "../../../src/adapters/claude/parse.js";
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
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 50,
      cachedInputTokens: 10,
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
    expect(result.usage).toBeNull();
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
});

describe("parseStreamLine", () => {
  it("returns system event from init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-abc-123",
      model: "claude-sonnet-4-20250514",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    if (event?.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("sess-abc-123");
      expect(event.model).toBe("claude-sonnet-4-20250514");
    }
  });

  it("returns null for non-init system events", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    expect(parseStreamLine(line)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
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

  it("extracts tool_call events", () => {
    const events = toStreamEvents(CLAUDE_TOOL_USE_OUTPUT);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("Read");
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
