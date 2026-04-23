import { describe, it, expect } from "vitest";
import {
  parseGeminiJsonl,
  parseGeminiStreamLine,
  isGeminiUnknownSessionError,
  isGeminiAuthRequired,
  isGeminiTurnLimit,
} from "../../../src/providers/gemini/parse.js";
import {
  GEMINI_SUCCESS_OUTPUT,
  GEMINI_CHECKPOINT_ID_OUTPUT,
  GEMINI_USAGE_METADATA_OUTPUT,
  GEMINI_ERROR_OUTPUT,
  GEMINI_AUTH_REQUIRED_STDERR,
  GEMINI_UNKNOWN_SESSION_STDERR,
  GEMINI_MALFORMED_OUTPUT,
  GEMINI_TOOL_USE_OUTPUT,
  GEMINI_TEXT_EVENTS_OUTPUT,
} from "../../fixtures/gemini-samples.js";

describe("parseGeminiJsonl", () => {
  it("extracts all fields from success output", () => {
    const result = parseGeminiJsonl(GEMINI_SUCCESS_OUTPUT);
    expect(result.sessionId).toBe("gemini-sess-001");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.costUsd).toBe(0.0038);
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 60,
      cachedInputTokens: 15,
    });
    expect(result.summary).toBe("I've completed the requested task.");
    expect(result.isError).toBe(false);
  });

  it("reads checkpoint_id as sessionId", () => {
    const result = parseGeminiJsonl(GEMINI_CHECKPOINT_ID_OUTPUT);
    expect(result.sessionId).toBe("chk-abc-789");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.costUsd).toBe(0.002);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 50,
    });
  });

  it("handles Google-style usageMetadata", () => {
    const result = parseGeminiJsonl(GEMINI_USAGE_METADATA_OUTPUT);
    expect(result.sessionId).toBe("gemini-sess-meta");
    expect(result.costUsd).toBe(0.005);
    expect(result.usage).toEqual({
      inputTokens: 180,
      outputTokens: 45,
      cachedInputTokens: 20,
    });
  });

  it("detects error events", () => {
    const result = parseGeminiJsonl(GEMINI_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Internal server error occurred");
  });

  it("skips malformed lines gracefully", () => {
    const result = parseGeminiJsonl(GEMINI_MALFORMED_OUTPUT);
    expect(result.sessionId).toBe("gemini-sess-mal");
    expect(result.model).toBe("gemini-2.5-pro");
  });

  it("handles empty stdout", () => {
    const result = parseGeminiJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("extracts text events into summary", () => {
    const result = parseGeminiJsonl(GEMINI_TEXT_EVENTS_OUTPUT);
    expect(result.summary).toContain("First chunk of text.");
    expect(result.summary).toContain("Second chunk of text.");
    expect(result.usage).toEqual({
      inputTokens: 80,
      outputTokens: 25,
      cachedInputTokens: 5,
    });
  });
});

describe("parseGeminiStreamLine", () => {
  it("returns system event from init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "gemini-sess-001",
      model: "gemini-2.5-pro",
    });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("system");
    if (event.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("gemini-sess-001");
      expect(event.model).toBe("gemini-2.5-pro");
    }
  });

  it("returns assistant/tool_call events from assistant message with mixed content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "gem-tu-001", name: "Read", input: { file_path: "/tmp/test.txt" } },
        ],
      },
    });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("assistant");
    expect(events[1]!.type).toBe("tool_call");
    if (events[1]!.type === "tool_call") {
      expect(events[1]!.name).toBe("Read");
      expect(events[1]!.toolCallId).toBe("gem-tu-001");
    }
  });

  it("returns callId from tool_use_id when id is absent", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", tool_use_id: "gem-tuid-002", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "tool_call") {
      expect(events[0]!.toolCallId).toBe("gem-tuid-002");
    }
  });

  it("callId is null when tool_use has no id fields", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Grep", input: { pattern: "test" } },
        ],
      },
    });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "tool_call") {
      expect(events[0]!.toolCallId).toBeNull();
    }
  });

  it("returns result event from result line", () => {
    const line = JSON.stringify({
      type: "result",
      result: "All done.",
      total_cost_usd: 0.005,
      is_error: false,
    });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("result");
    if (events[0]!.type === "result") {
      expect(events[0]!.text).toBe("All done.");
      expect(events[0]!.isError).toBe(false);
    }
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseGeminiStreamLine("not json")).toHaveLength(0);
  });

  it("returns an `unknown` variant for non-init system events (forward-compat)", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    const events = parseGeminiStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("unknown");
  });
});

describe("isGeminiUnknownSessionError", () => {
  it("detects in stdout and stderr", () => {
    expect(isGeminiUnknownSessionError("", GEMINI_UNKNOWN_SESSION_STDERR)).toBe(true);
    expect(isGeminiUnknownSessionError("session xyz not found", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isGeminiUnknownSessionError(GEMINI_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isGeminiAuthRequired", () => {
  it("detects auth required in stderr", () => {
    expect(isGeminiAuthRequired("", GEMINI_AUTH_REQUIRED_STDERR)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isGeminiAuthRequired(GEMINI_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isGeminiTurnLimit", () => {
  it("detects exit code 53", () => {
    expect(isGeminiTurnLimit(53)).toBe(true);
  });

  it("returns false for exit code 0", () => {
    expect(isGeminiTurnLimit(0)).toBe(false);
  });
});
