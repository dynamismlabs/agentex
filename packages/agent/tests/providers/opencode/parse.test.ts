import { describe, it, expect } from "vitest";
import {
  parseOpenCodeJsonl,
  parseOpenCodeStreamLine,
  isOpenCodeUnknownSessionError,
  isOpenCodeAuthRequired,
} from "../../../src/providers/opencode/parse.js";
import {
  OPENCODE_SUCCESS_OUTPUT,
  OPENCODE_ERROR_OUTPUT,
  OPENCODE_TOOL_USE_OUTPUT,
  OPENCODE_TOOL_ERROR_OUTPUT,
  OPENCODE_UNKNOWN_SESSION_STDERR,
  OPENCODE_AUTH_REQUIRED_STDERR,
  OPENCODE_MALFORMED_OUTPUT,
  OPENCODE_REASONING_OUTPUT,
} from "../../fixtures/opencode-samples.js";

describe("parseOpenCodeJsonl", () => {
  it("extracts all fields from success output", () => {
    const result = parseOpenCodeJsonl(OPENCODE_SUCCESS_OUTPUT);
    expect(result.sessionId).toBe("oc-sess-1");
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80, // 50 output + 30 reasoning
      cachedInputTokens: 10,
    });
    expect(result.costUsd).toBe(0.0055);
    expect(result.summary).toBe("Task completed successfully.");
    expect(result.isError).toBe(false);
  });

  it("detects error events", () => {
    const result = parseOpenCodeJsonl(OPENCODE_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Model request failed");
  });

  it("detects tool_use errors", () => {
    const result = parseOpenCodeJsonl(OPENCODE_TOOL_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Command failed with exit code 1");
  });

  it("skips malformed lines", () => {
    const result = parseOpenCodeJsonl(OPENCODE_MALFORMED_OUTPUT);
    expect(result.sessionId).toBe("oc-sess-mal");
    expect(result.summary).toBe("Done despite bad lines.");
  });

  it("handles empty stdout", () => {
    const result = parseOpenCodeJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("includes reasoning tokens in outputTokens", () => {
    const result = parseOpenCodeJsonl(OPENCODE_REASONING_OUTPUT);
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 100, // 40 output + 60 reasoning
      cachedInputTokens: 20,
    });
    expect(result.costUsd).toBe(0.008);
  });
});

describe("parseOpenCodeStreamLine", () => {
  it("returns assistant event from text type", () => {
    const line = JSON.stringify({
      type: "text",
      part: { text: "Hello there." },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("assistant");
    if (event?.type === "assistant") {
      expect(event.text).toBe("Hello there.");
    }
  });

  it("returns tool_call from tool_use", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        name: "bash",
        input: { command: "ls" },
        state: { status: "running" },
      },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.name).toBe("bash");
    }
  });

  it("returns result from step_finish", () => {
    const line = JSON.stringify({ type: "step_finish" });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    if (event?.type === "result") {
      expect(event.isError).toBe(false);
    }
  });

  it("returns error result from error", () => {
    const line = JSON.stringify({ type: "error", message: "Something broke" });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    if (event?.type === "result") {
      expect(event.isError).toBe(true);
      expect(event.text).toBe("Something broke");
    }
  });

  it("returns null for unknown/malformed", () => {
    expect(parseOpenCodeStreamLine("not json")).toBeNull();
    expect(parseOpenCodeStreamLine(JSON.stringify({ type: "unknown_event" }))).toBeNull();
  });
});

describe("isOpenCodeUnknownSessionError", () => {
  it("detects in stderr", () => {
    expect(isOpenCodeUnknownSessionError("", OPENCODE_UNKNOWN_SESSION_STDERR)).toBe(true);
  });

  it("detects in stdout", () => {
    expect(isOpenCodeUnknownSessionError("unknown session abc", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isOpenCodeUnknownSessionError(OPENCODE_SUCCESS_OUTPUT, "")).toBe(false);
  });
});

describe("isOpenCodeAuthRequired", () => {
  it("detects in stderr", () => {
    expect(isOpenCodeAuthRequired("", OPENCODE_AUTH_REQUIRED_STDERR)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isOpenCodeAuthRequired(OPENCODE_SUCCESS_OUTPUT, "")).toBe(false);
  });
});
