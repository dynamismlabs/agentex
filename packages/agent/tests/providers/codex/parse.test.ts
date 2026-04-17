import { describe, it, expect } from "vitest";
import {
  parseCodexJsonl,
  parseCodexStreamLine,
  stripCodexRolloutNoise,
  isCodexAuthRequired,
} from "../../../src/providers/codex/parse.js";
import {
  CODEX_SUCCESS_OUTPUT,
  CODEX_AUTH_STDERR,
  CODEX_ERROR_OUTPUT,
  CODEX_TURN_FAILED_OUTPUT,
  CODEX_MALFORMED_OUTPUT,
  CODEX_COMMAND_EXECUTION_OUTPUT,
  CODEX_COMMAND_FAILURE_OUTPUT,
  CODEX_FUNCTION_CALL_OUTPUT,
  CODEX_FUNCTION_CALL_FAILURE_OUTPUT,
  CODEX_ROLLOUT_NOISE,
} from "../../fixtures/jsonl-samples.js";

describe("parseCodexJsonl", () => {
  it("extracts all fields from success output", () => {
    const result = parseCodexJsonl(CODEX_SUCCESS_OUTPUT);
    expect(result.sessionId).toBe("thread-xyz-1");
    expect(result.model).toBe("o4-mini");
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 20 });
    expect(result.summary).toBe("Task completed by Codex.");
    expect(result.isError).toBe(false);
    expect(result.costUsd).toBeNull();
  });

  it("detects error events", () => {
    const result = parseCodexJsonl(CODEX_ERROR_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("detects turn.failed events", () => {
    const result = parseCodexJsonl(CODEX_TURN_FAILED_OUTPUT);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("Turn failed due to error");
  });

  it("skips malformed lines", () => {
    const result = parseCodexJsonl(CODEX_MALFORMED_OUTPUT);
    expect(result.sessionId).toBe("thread-mal-1");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("handles empty stdout", () => {
    const result = parseCodexJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBeNull();
  });
});

describe("parseCodexStreamLine", () => {
  it("returns system event from thread.started", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "thread-abc" });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    if (event?.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("thread-abc");
      expect(event.model).toBeNull();
    }
  });

  it("returns tool_call from item.started with command_execution", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: '/bin/bash -lc "ls -la"',
        status: "in_progress",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.name).toBe("command_execution");
      expect(event.input).toBe('/bin/bash -lc "ls -la"');
    }
  });

  it("includes callId on command_execution tool_call when item has id", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        id: "cmd-start-001",
        command: '/bin/bash -lc "echo hello"',
        status: "in_progress",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.callId).toBe("cmd-start-001");
    }
  });

  it("returns tool_call from item.started with function_call", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        type: "function_call",
        id: "fc-001",
        name: "read_file",
        arguments: JSON.stringify({ path: "/tmp/test.txt" }),
        status: "in_progress",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.callId).toBe("fc-001");
      expect(event.name).toBe("read_file");
      expect(event.input).toBe(JSON.stringify({ path: "/tmp/test.txt" }));
    }
  });

  it("returns tool_call from item.started with function_call using call_id", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        type: "function_call",
        call_id: "fc-alt-001",
        name: "write_file",
        input: { path: "/tmp/out.txt", content: "data" },
        status: "in_progress",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_call") {
      expect(event.callId).toBe("fc-alt-001");
      expect(event.name).toBe("write_file");
    }
  });

  it("returns tool_result from item.completed with function_call (success)", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call",
        id: "fc-001",
        name: "read_file",
        output: "file contents here",
        status: "completed",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("fc-001");
      expect(event.content).toBe("file contents here");
      expect(event.isError).toBe(false);
    }
  });

  it("returns tool_result from item.completed with function_call (failed)", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call",
        call_id: "fc-002",
        name: "write_file",
        result: "Permission denied",
        status: "failed",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("fc-002");
      expect(event.content).toBe("Permission denied");
      expect(event.isError).toBe(true);
    }
  });

  it("returns tool_result from item.completed with command_execution (success)", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-001",
        command: '/bin/bash -lc "ls"',
        aggregated_output: "file1.txt\nfile2.txt",
        exit_code: 0,
        status: "completed",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_result");
    if (event?.type === "tool_result") {
      expect(event.toolCallId).toBe("cmd-001");
      expect(event.content).toBe("file1.txt\nfile2.txt");
      expect(event.isError).toBe(false);
    }
  });

  it("returns tool_result with isError=true for non-zero exit code", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-002",
        command: '/bin/bash -lc "cat /nonexistent"',
        aggregated_output: "cat: /nonexistent: No such file or directory",
        exit_code: 1,
        status: "completed",
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    if (event?.type === "tool_result") {
      expect(event.isError).toBe(true);
    }
  });

  it("still returns assistant event from agent_message", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [{ type: "output_text", text: "Done." }],
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("assistant");
    if (event?.type === "assistant") {
      expect(event.text).toBe("Done.");
    }
  });

  it("returns null for unknown event types", () => {
    const line = JSON.stringify({ type: "unknown_event" });
    expect(parseCodexStreamLine(line)).toBeNull();
  });
});

describe("stripCodexRolloutNoise", () => {
  it("removes rollout noise lines", () => {
    const cleaned = stripCodexRolloutNoise(CODEX_ROLLOUT_NOISE);
    expect(cleaned).not.toContain("codex_core::rollout::list");
    expect(cleaned).toContain("actual useful stderr output");
  });

  it("preserves normal lines", () => {
    const normal = "normal output\nmore output";
    expect(stripCodexRolloutNoise(normal)).toBe(normal);
  });
});

describe("isCodexAuthRequired", () => {
  it("detects missing OPENAI_API_KEY", () => {
    expect(isCodexAuthRequired("", CODEX_AUTH_STDERR)).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isCodexAuthRequired(CODEX_SUCCESS_OUTPUT, "")).toBe(false);
  });
});
