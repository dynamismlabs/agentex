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

  it("returns callId on tool_call when part has id", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        id: "oc-tu-001",
        name: "bash",
        input: { command: "echo hi" },
        state: { status: "running" },
      },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.toolCallId).toBe("oc-tu-001");
      expect(event.name).toBe("bash");
    }
  });

  it("returns callId from tool_use_id when id is absent", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool_use_id: "oc-tuid-002",
        name: "read",
        input: { file: "test.txt" },
        state: { status: "running" },
      },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.toolCallId).toBe("oc-tuid-002");
    }
  });

  it("returns tool_result from completed tool_use", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        id: "oc-tu-003",
        name: "bash",
        input: { command: "ls" },
        state: { status: "completed", result: "file1.txt\nfile2.txt" },
      },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("oc-tu-003");
      expect(event.content).toBe("file1.txt\nfile2.txt");
      expect(event.isError).toBe(false);
    }
  });

  it("returns tool_result from errored tool_use", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        id: "oc-tu-004",
        name: "bash",
        input: { command: "cat /missing" },
        state: { status: "error", error: "No such file" },
      },
    });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("oc-tu-004");
      expect(event.content).toBe("No such file");
      expect(event.isError).toBe(true);
    }
  });

  it("keeps step_finish non-terminal", () => {
    const line = JSON.stringify({ type: "step_finish" });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("unknown");
    if (event?.type === "unknown") {
      expect(event.subtype).toBe("step_finish");
    }
  });

  it("keeps wire error non-terminal so execution owns the terminal result", () => {
    const line = JSON.stringify({ type: "error", message: "Something broke" });
    const event = parseOpenCodeStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("unknown");
    if (event?.type === "unknown") {
      expect(event.subtype).toBe("error");
    }
  });

  it("returns null for malformed; `unknown` variant for unrecognized types", () => {
    expect(parseOpenCodeStreamLine("not json")).toBeNull();
    const unknown = parseOpenCodeStreamLine(JSON.stringify({ type: "unknown_event" }));
    expect(unknown).not.toBeNull();
    expect(unknown!.type).toBe("unknown");
    if (unknown?.type === "unknown") {
      expect(unknown.subtype).toBe("unknown_event");
    }
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
