import { describe, it, expect } from "vitest";
import {
  parsePiJsonl,
  parsePiStreamLine,
  isPiUnknownSessionError,
} from "../../../src/providers/pi/parse.js";
import {
  PI_SUCCESS_OUTPUT,
  PI_MESSAGE_UPDATE_OUTPUT,
  PI_TOOL_EXECUTION_OUTPUT,
  PI_USAGE_EVENT_OUTPUT,
  PI_ERROR_OUTPUT,
  PI_UNKNOWN_SESSION_STDERR,
  PI_SKIPPED_RPC_OUTPUT,
  PI_MALFORMED_OUTPUT,
} from "../../fixtures/pi-samples.js";

describe("parsePiJsonl", () => {
  it("extracts from success output", () => {
    const result = parsePiJsonl(PI_SUCCESS_OUTPUT);
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 10,
      costUsd: 0.004,
    });
    expect(result.summary).toBe("Final answer from agent.");
    expect(result.isError).toBe(false);
  });

  it("accumulates message_update deltas, uses agent_end final message", () => {
    const result = parsePiJsonl(PI_MESSAGE_UPDATE_OUTPUT);
    // agent_end final message overrides accumulated deltas
    expect(result.summary).toBe("Hello world! Final.");
  });

  it("extracts tool execution usage from turn_end", () => {
    const result = parsePiJsonl(PI_TOOL_EXECUTION_OUTPUT);
    expect(result.usage).toEqual({
      inputTokens: 80,
      outputTokens: 30,
      cachedInputTokens: 5,
      costUsd: 0.003,
    });
    expect(result.summary).toBe("Listed files.");
  });

  it("handles standalone usage events", () => {
    const result = parsePiJsonl(PI_USAGE_EVENT_OUTPUT);
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 60,
      cachedInputTokens: 25,
      costUsd: 0.007,
    });
  });

  it("detects errors", () => {
    const result = parsePiJsonl(PI_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Pi agent encountered an error");
  });

  it("skips RPC protocol internals", () => {
    const result = parsePiJsonl(PI_SKIPPED_RPC_OUTPUT);
    // Only the message_update line should contribute
    expect(result.summary).toBe("Actual content.");
    expect(result.isError).toBe(false);
  });

  it("skips malformed lines", () => {
    const result = parsePiJsonl(PI_MALFORMED_OUTPUT);
    expect(result.summary).toBe("Survived malformed.");
    expect(result.isError).toBe(false);
  });

  it("handles empty stdout", () => {
    const result = parsePiJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("sessionId is always null (Pi uses file-based sessions)", () => {
    const result = parsePiJsonl(PI_SUCCESS_OUTPUT);
    expect(result.sessionId).toBeNull();
  });
});

describe("parsePiStreamLine", () => {
  it("returns assistant event from message_update text_delta", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("assistant");
    if (event?.type === "assistant") {
      expect(event.text).toBe("Hello world");
    }
  });

  it("returns tool_call from tool_execution_start", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "ls" },
    });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.name).toBe("bash");
    }
  });

  it("returns callId on tool_call when toolCallId is present", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "pi-tc-001",
      toolName: "bash",
      args: { command: "echo hello" },
    });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.callId).toBe("pi-tc-001");
      expect(event.name).toBe("bash");
    }
  });

  it("callId is undefined when toolCallId is absent on tool_execution_start", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "grep",
      args: { pattern: "test" },
    });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.callId).toBeUndefined();
    }
  });

  it("returns tool_result from tool_execution_end", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tc-001",
      result: "output text",
      isError: false,
    });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("tc-001");
      expect(event.content).toBe("output text");
      expect(event.isError).toBe(false);
    }
  });

  it("returns result from agent_end", () => {
    const line = JSON.stringify({ type: "agent_end" });
    const event = parsePiStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    if (event?.type === "result") {
      expect(event.isError).toBe(false);
    }
  });

  it("returns null for unknown types", () => {
    expect(parsePiStreamLine(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parsePiStreamLine("not json")).toBeNull();
  });
});

describe("isPiUnknownSessionError", () => {
  it("detects in stdout and stderr", () => {
    expect(isPiUnknownSessionError("", PI_UNKNOWN_SESSION_STDERR)).toBe(true);
    expect(isPiUnknownSessionError("session not found", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isPiUnknownSessionError("all good", "")).toBe(false);
  });
});
