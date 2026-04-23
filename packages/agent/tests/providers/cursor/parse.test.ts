import { describe, it, expect } from "vitest";
import {
  parseCursorJsonl,
  parseCursorStreamLine,
  normalizeCursorStreamLine,
  isCursorUnknownSessionError,
  isCursorAuthRequired,
} from "../../../src/providers/cursor/parse.js";
import {
  CURSOR_SUCCESS_OUTPUT,
  CURSOR_PREFIXED_OUTPUT,
  CURSOR_STEP_FINISH_OUTPUT,
  CURSOR_ERROR_OUTPUT,
  CURSOR_AUTH_REQUIRED_STDERR,
  CURSOR_UNKNOWN_SESSION_STDERR,
  CURSOR_MALFORMED_OUTPUT,
} from "../../fixtures/cursor-samples.js";

describe("normalizeCursorStreamLine", () => {
  it("strips 'stdout: ' prefix and returns stream='stdout'", () => {
    const input = 'stdout: {"type":"system","subtype":"init"}';
    const result = normalizeCursorStreamLine(input);
    expect(result.stream).toBe("stdout");
    expect(result.line).toBe('{"type":"system","subtype":"init"}');
  });

  it("strips 'stderr: ' prefix and returns stream='stderr'", () => {
    const input = 'stderr: {"type":"error","message":"fail"}';
    const result = normalizeCursorStreamLine(input);
    expect(result.stream).toBe("stderr");
    expect(result.line).toBe('{"type":"error","message":"fail"}');
  });

  it("returns original line with stream=null when no prefix", () => {
    const input = '{"type":"system","subtype":"init"}';
    const result = normalizeCursorStreamLine(input);
    expect(result.stream).toBeNull();
    expect(result.line).toBe(input);
  });

  it("returns empty line for empty input", () => {
    const result = normalizeCursorStreamLine("");
    expect(result.line).toBe("");
    expect(result.stream).toBeNull();
  });
});

describe("parseCursorJsonl", () => {
  it("extracts all fields from success output", () => {
    const result = parseCursorJsonl(CURSOR_SUCCESS_OUTPUT);
    expect(result.sessionId).toBe("cursor-sess-001");
    expect(result.model).toBe("cursor-fast");
    expect(result.costUsd).toBe(0.0045);
    expect(result.usage).toEqual({
      inputTokens: 180,
      outputTokens: 55,
      cachedInputTokens: 12,
    });
    expect(result.summary).toBe("Changes applied successfully.");
    expect(result.isError).toBe(false);
  });

  it("handles prefixed output (stdout: prefix)", () => {
    const result = parseCursorJsonl(CURSOR_PREFIXED_OUTPUT);
    expect(result.sessionId).toBe("cursor-sess-pfx");
    expect(result.model).toBe("cursor-fast");
    expect(result.costUsd).toBe(0.003);
    expect(result.usage).toEqual({
      inputTokens: 90,
      outputTokens: 30,
      cachedInputTokens: 0,
    });
  });

  it("accumulates step_finish tokens and cost", () => {
    const result = parseCursorJsonl(CURSOR_STEP_FINISH_OUTPUT);
    expect(result.sessionId).toBe("cursor-sess-step");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 10,
    });
    expect(result.costUsd).toBe(0.0032);
  });

  it("detects error events", () => {
    const result = parseCursorJsonl(CURSOR_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Rate limit exceeded");
  });

  it("skips malformed lines", () => {
    const result = parseCursorJsonl(CURSOR_MALFORMED_OUTPUT);
    expect(result.sessionId).toBe("cursor-sess-mal");
    expect(result.model).toBe("cursor-fast");
  });

  it("handles empty stdout", () => {
    const result = parseCursorJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBeNull();
  });
});

describe("parseCursorStreamLine", () => {
  it("returns system event from init", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "cursor-sess-001",
      model: "cursor-fast",
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    if (event?.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("cursor-sess-001");
      expect(event.model).toBe("cursor-fast");
    }
  });

  it("returns assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Done." }],
      },
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("assistant");
    if (event?.type === "assistant") {
      expect(event.text).toBe("Done.");
    }
  });

  it("returns result event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Completed.",
      total_cost_usd: 0.005,
      is_error: false,
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    if (event?.type === "result") {
      expect(event.text).toBe("Completed.");
      expect(event.isError).toBe(false);
    }
  });

  it("returns tool_call from assistant message with tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "cur-tu-001", name: "Edit", input: { file: "test.ts" } },
        ],
      },
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.toolCallId).toBe("cur-tu-001");
      expect(event.name).toBe("Edit");
    }
  });

  it("returns tool_result from assistant message with tool_result block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "cur-tu-001", content: "edited successfully", is_error: false },
        ],
      },
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("cur-tu-001");
      expect(event.content).toBe("edited successfully");
      expect(event.isError).toBe(false);
    }
  });

  it("callId is undefined when tool_use block has no id", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "pwd" } },
        ],
      },
    });
    const event = parseCursorStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.toolCallId).toBeNull();
    }
  });

  it("returns null for malformed JSON", () => {
    expect(parseCursorStreamLine("not json")).toBeNull();
  });
});

describe("isCursorUnknownSessionError", () => {
  it("detects in stderr", () => {
    expect(isCursorUnknownSessionError("", CURSOR_UNKNOWN_SESSION_STDERR)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isCursorUnknownSessionError(CURSOR_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isCursorAuthRequired", () => {
  it("detects auth required in stderr", () => {
    expect(isCursorAuthRequired("", CURSOR_AUTH_REQUIRED_STDERR)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isCursorAuthRequired(CURSOR_SUCCESS_OUTPUT, "")).toBe(false);
  });
});
