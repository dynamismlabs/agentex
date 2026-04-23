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
    // Codex JSONL never emits model; executors must fall back to the request.
    expect(result.model).toBeNull();
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
      expect(event.toolCallId).toBe("cmd-start-001");
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
      expect(event.toolCallId).toBe("fc-001");
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
      expect(event.toolCallId).toBe("fc-alt-001");
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

  it("returns an `unknown` event for unrecognized types (forward-compat)", () => {
    const line = JSON.stringify({ type: "unknown_event" });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("unknown");
    if (event?.type === "unknown") {
      expect(event.subtype).toBe("unknown_event");
    }
  });

  it("unknown variant threads through the provided sessionId and preserves raw", () => {
    const rawEvent = { type: "some_new_codex_event", future_field: 42 };
    const event = parseCodexStreamLine(JSON.stringify(rawEvent), "thread-abc-xyz");
    expect(event).not.toBeNull();
    expect(event!.type).toBe("unknown");
    if (event?.type === "unknown") {
      expect(event.subtype).toBe("some_new_codex_event");
      expect(event.sessionId).toBe("thread-abc-xyz");
      expect(event.eventId).toBeNull();            // Codex never emits per-event uuids
      expect(event.turnId).toBeNull();             // NDJSON path: no turn scope
      expect(event.providerType).toBe("codex");
      expect(event.raw).toEqual(rawEvent);
    }
  });

  it("NDJSON reasoning item emits a thinking event", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "reasoning",
        id: "rs_abc",
        summary: [{ type: "summary_text", text: "Thinking about it..." }],
        content: [],
      },
    });
    const event = parseCodexStreamLine(line, "thread-1");
    expect(event).not.toBeNull();
    expect(event!.type).toBe("thinking");
    if (event?.type === "thinking") {
      expect(event.text).toBe("Thinking about it...");
      expect(event.messageId).toBe("rs_abc");
      expect(event.sessionId).toBe("thread-1");
      expect(event.turnId).toBeNull();
    }
  });
});

describe("parseCodexStreamLine — v2 JSON-RPC (codex --json app-server)", () => {
  it("detects v2 by presence of `method` and routes to the v2 parser", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: "019dbae3-f05e-7731-9f92-7288c9ac06d4",
          cwd: "/tmp/probe",
          cliVersion: "0.122.0",
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    if (event?.type === "system") {
      expect(event.sessionId).toBe("019dbae3-f05e-7731-9f92-7288c9ac06d4");
      expect(event.turnId).toBeNull();                        // no turn yet
      expect(event.cwd).toBe("/tmp/probe");
    }
  });

  it("v2 item/completed agentMessage populates sessionId and turnId from params", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-uuid",
        turnId: "turn-uuid",
        item: {
          type: "agentMessage",
          id: "msg_abc123",
          text: "Hello",
          phase: "final_answer",
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("assistant");
    if (event?.type === "assistant") {
      expect(event.text).toBe("Hello");
      expect(event.sessionId).toBe("thread-uuid");
      expect(event.turnId).toBe("turn-uuid");
      expect(event.messageId).toBe("msg_abc123");
    }
  });

  it("v2 item/completed reasoning emits a thinking event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "rs_xyz",
          summary: [],
          content: [],
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("thinking");
    if (event?.type === "thinking") {
      expect(event.messageId).toBe("rs_xyz");
      expect(event.turnId).toBe("turn-1");
    }
  });

  it("v2 item/started command_execution emits tool_call with turnId", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-xyz",
        item: {
          type: "command_execution",
          id: "call_1",
          command: "echo hi",
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.toolCallId).toBe("call_1");
      expect(event.name).toBe("command_execution");
      expect(event.input).toBe("echo hi");
      expect(event.turnId).toBe("turn-xyz");
    }
  });

  it("v2 turn/completed emits result with durationMs from turn.durationMs", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "t1",
        turn: {
          id: "turn-1",
          status: "completed",
          durationMs: 4029,
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    if (event?.type === "result") {
      expect(event.isError).toBe(false);
      expect(event.durationMs).toBe(4029);
      expect(event.terminalReason).toBe("completed");
      expect(event.turnId).toBe("turn-1");
    }
  });

  it("v2 turn/started is skipped (returns null) — lifecycle marker only", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1", status: "inProgress" } },
    });
    expect(parseCodexStreamLine(line)).toBeNull();
  });

  it("v2 userMessage items are skipped — consumer persists user input itself", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "um_abc",
          content: [{ type: "text", text: "hi" }],
        },
      },
    });
    expect(parseCodexStreamLine(line)).toBeNull();
  });

  it("v2 item/agentMessage/delta is skipped (block-level streaming only in v1)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "msg_1", delta: "Hel" },
    });
    expect(parseCodexStreamLine(line)).toBeNull();
  });

  it("v2 account/rateLimits/updated emits a rate_limit event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 24 },
        },
      },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("rate_limit");
    if (event?.type === "rate_limit") {
      expect(event.status).toBe("allowed");
      expect(event.limitType).toBe("codex");
    }
  });

  it("v2 pure-telemetry methods are skipped", () => {
    const tokenUsage = JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "t1", tokenUsage: {} },
    });
    const status = JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/status/changed",
      params: { threadId: "t1", status: { type: "active" } },
    });
    expect(parseCodexStreamLine(tokenUsage)).toBeNull();
    expect(parseCodexStreamLine(status)).toBeNull();
  });

  it("v2 unknown method surfaces as unknown variant with method as subtype", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "something/brand-new",
      params: { threadId: "t1", whatever: 42 },
    });
    const event = parseCodexStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("unknown");
    if (event?.type === "unknown") {
      expect(event.subtype).toBe("something/brand-new");
      expect(event.sessionId).toBe("t1");
      expect(event.raw).toMatchObject({ method: "something/brand-new" });
    }
  });

  it("v2 items share the same turnId across the turn (turn-boundary test)", () => {
    const turn1Line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-A",
        item: { type: "agentMessage", id: "msg_1", text: "first" },
      },
    });
    const turn2Line = JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-B",
        item: { type: "agentMessage", id: "msg_2", text: "second" },
      },
    });
    const e1 = parseCodexStreamLine(turn1Line);
    const e2 = parseCodexStreamLine(turn2Line);
    expect(e1?.turnId).toBe("turn-A");
    expect(e2?.turnId).toBe("turn-B");
    // sessionId stable, messageId unique per item in v2
    expect(e1?.sessionId).toBe(e2?.sessionId);
    expect(e1?.messageId).not.toBe(e2?.messageId);
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
