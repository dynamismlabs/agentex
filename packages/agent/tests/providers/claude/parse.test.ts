import { describe, it, expect } from "vitest";
import {
  parseClaudeStreamJson,
  toStreamEvents,
  parseStreamLine,
  getClaudeTaskDetails,
  isClaudeUnknownSessionError,
  isClaudeAuthRequired,
  isClaudeMaxTurns,
  classifyClaudeAuthFromResult,
  CLAUDE_LOGIN_COMMAND,
} from "../../../src/providers/claude/parse.js";
import {
  CLAUDE_SUCCESS_OUTPUT,
  CLAUDE_MAX_TURNS_OUTPUT,
  CLAUDE_AUTH_REQUIRED_OUTPUT,
  CLAUDE_AUTH_INVALID_API_KEY_OUTPUT,
  CLAUDE_AUTH_NOT_LOGGED_IN_OUTPUT,
  CLAUDE_AUTH_OAUTH_EXPIRED_OUTPUT,
  CLAUDE_AUTH_BEDROCK_BAD_OUTPUT,
  CLAUDE_UNKNOWN_SESSION_OUTPUT,
  CLAUDE_MALFORMED_OUTPUT,
  CLAUDE_TOOL_USE_OUTPUT,
} from "../../fixtures/stream-json-samples.js";
import type { StreamEvent } from "../../../src/types.js";

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
      slash_commands: ["help", "code-review"],
      skills: ["code-review"],
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("system");
    if (event.type === "system") {
      expect(event.subtype).toBe("init");
      expect(event.sessionId).toBe("sess-abc-123");
      expect(event.model).toBe("claude-sonnet-4-20250514");
      expect(event.slashCommands).toEqual(["help", "code-review"]);
      expect(event.skills).toEqual(["code-review"]);
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

// ---------------------------------------------------------------------------
// auth_required emission — structured signal-driven, not text-match
// ---------------------------------------------------------------------------

describe("auth_required stream event", () => {
  it("emits auth_required + result for invalid API key (api_error_status=401)", () => {
    const events = toStreamEvents(CLAUDE_AUTH_INVALID_API_KEY_OUTPUT);
    const authEvents = events.filter((e) => e.type === "auth_required");
    expect(authEvents).toHaveLength(1);
    const auth = authEvents[0]!;
    if (auth.type !== "auth_required") throw new Error("type narrow");
    expect(auth.httpStatus).toBe(401);
    expect(auth.reason).toBe("invalid");
    expect(auth.loginCommand).toBe(CLAUDE_LOGIN_COMMAND);
    expect(auth.message).toBe("Invalid API key · Fix external API key");
    expect(auth.providerType).toBe("claude");
    expect(auth.sessionId).toBe("sess-bad-api-key");
    // The result event still fires alongside.
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("suppresses the synthetic-assistant message that duplicates the auth error text", () => {
    const events = toStreamEvents(CLAUDE_AUTH_INVALID_API_KEY_OUTPUT);
    expect(events.filter((e) => e.type === "assistant")).toHaveLength(0);
  });

  it("classifies short-circuited 'Not logged in' as reason=missing with httpStatus=null", () => {
    const events = toStreamEvents(CLAUDE_AUTH_NOT_LOGGED_IN_OUTPUT);
    const auth = events.find((e) => e.type === "auth_required");
    expect(auth).toBeDefined();
    if (auth?.type !== "auth_required") throw new Error("type narrow");
    expect(auth.httpStatus).toBeNull();
    expect(auth.reason).toBe("missing");
    expect(auth.message).toBe("Not logged in · Please run /login");
  });

  it("classifies OAuth expired text", () => {
    const events = toStreamEvents(CLAUDE_AUTH_OAUTH_EXPIRED_OUTPUT);
    const auth = events.find((e) => e.type === "auth_required");
    if (auth?.type !== "auth_required") throw new Error("expected auth_required");
    expect(auth.reason).toBe("expired");
    expect(auth.httpStatus).toBe(401);
  });

  it("classifies bedrock 403 as reason=invalid", () => {
    const events = toStreamEvents(CLAUDE_AUTH_BEDROCK_BAD_OUTPUT);
    const auth = events.find((e) => e.type === "auth_required");
    if (auth?.type !== "auth_required") throw new Error("expected auth_required");
    expect(auth.httpStatus).toBe(403);
    expect(auth.reason).toBe("invalid");
  });

  it("does not emit auth_required for successful runs", () => {
    const events = toStreamEvents(CLAUDE_SUCCESS_OUTPUT);
    expect(events.filter((e) => e.type === "auth_required")).toHaveLength(0);
  });

  it("does not emit auth_required for max_turns errors", () => {
    const events = toStreamEvents(CLAUDE_MAX_TURNS_OUTPUT);
    expect(events.filter((e) => e.type === "auth_required")).toHaveLength(0);
  });

  it("does not emit auth_required for plain rate-limit results", () => {
    // A 429 stream — is_error: true but no auth-shaped text, no
    // api_error_status of 401/403.
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-429", model: "m" }),
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "API Error: Request rejected (429) · this may be a temporary capacity issue",
        session_id: "s-429",
      }),
    ].join("\n");
    const events = toStreamEvents(stdout);
    expect(events.filter((e) => e.type === "auth_required")).toHaveLength(0);
  });

  it("does not emit auth_required for 500 server errors", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-500", model: "m" }),
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 500,
        result: "API Error: 500 Internal server error",
        session_id: "s-500",
      }),
    ].join("\n");
    const events = toStreamEvents(stdout);
    expect(events.filter((e) => e.type === "auth_required")).toHaveLength(0);
    // The result event should still surface the error.
    const result = events.find((e) => e.type === "result");
    if (result?.type !== "result") throw new Error("expected result");
    expect(result.isError).toBe(true);
  });

  it("preserves the synthetic-assistant suppression only for the authentication_failed variant", () => {
    // Regular assistant events without the auth signal should still emit.
    const line = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-real",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "Hello!" }],
      },
      session_id: "s-real",
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("assistant");
  });
});

describe("classifyClaudeAuthFromResult", () => {
  it("returns null for non-error results", () => {
    expect(classifyClaudeAuthFromResult({ is_error: false, result: "ok" })).toBeNull();
  });

  it("returns null for is_error results without auth indicators", () => {
    expect(
      classifyClaudeAuthFromResult({
        is_error: true,
        api_error_status: 429,
        result: "rate limited",
      }),
    ).toBeNull();
  });

  it.each([
    ["OAuth token has expired · Please run /login", "expired"],
    ["OAuth token revoked · Please run /login", "revoked"],
    ["Not logged in · Please run /login", "missing"],
    ["Invalid API key · Fix external API key", "invalid"],
    ["OAuth token does not meet scope requirement: user:profile", "scope"],
    [
      "Your ANTHROPIC_API_KEY belongs to a disabled organization · ...",
      "disabled_org",
    ],
    ["Routines are disabled by your organization's policy.", "routines_disabled"],
    ["Failed to authenticate. API Error: 401 Invalid bearer token", "invalid"],
  ])("maps %s → reason=%s", (text, expectedReason) => {
    const out = classifyClaudeAuthFromResult({
      is_error: true,
      api_error_status: 401,
      result: text,
    });
    expect(out?.reason).toBe(expectedReason);
  });

  it("preserves httpStatus=null when api_error_status is absent (short-circuit path)", () => {
    const out = classifyClaudeAuthFromResult({
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(out?.httpStatus).toBeNull();
    expect(out?.reason).toBe("missing");
  });

  it("returns reason=unknown for an unrecognized 401 text but still emits", () => {
    const out = classifyClaudeAuthFromResult({
      is_error: true,
      api_error_status: 401,
      result: "Some new auth phrasing the docs haven't documented yet",
    });
    expect(out).not.toBeNull();
    expect(out?.reason).toBe("unknown");
    expect(out?.httpStatus).toBe(401);
  });
});

describe("parseClaudeStreamJson errorCode", () => {
  it("sets errorCode=auth_required from structured signal", () => {
    const result = parseClaudeStreamJson(CLAUDE_AUTH_INVALID_API_KEY_OUTPUT);
    expect(result.errorCode).toBe("auth_required");
    expect(result.isError).toBe(true);
  });

  it("sets errorCode=auth_required from short-circuit 'Not logged in' text", () => {
    const result = parseClaudeStreamJson(CLAUDE_AUTH_NOT_LOGGED_IN_OUTPUT);
    expect(result.errorCode).toBe("auth_required");
  });

  it("still detects max_turns when both signals could fire", () => {
    const result = parseClaudeStreamJson(CLAUDE_MAX_TURNS_OUTPUT);
    expect(result.errorCode).toBe("max_turns");
  });
});

// ---------------------------------------------------------------------------
// getClaudeTaskDetails — typed view of background-task lifecycle events.
// Wire shapes captured from Claude CLI 2.1.187. These arrive as type:"system"
// on the wire but surface as type:"unknown" through agentex's escape hatch, so
// every test drives the real path: parseStreamLine -> unknown event -> accessor.
// ---------------------------------------------------------------------------

describe("getClaudeTaskDetails", () => {
  function parseOne(wire: Record<string, unknown>): StreamEvent {
    const events = parseStreamLine(JSON.stringify(wire));
    expect(events).toHaveLength(1);
    return events[0]!;
  }

  it("surfaces task events as `unknown`, not `system`", () => {
    const ev = parseOne({ type: "system", subtype: "task_started", task_id: "t1", description: "x" });
    // The discriminator gotcha consumers must know: NOT type:"system".
    expect(ev.type).toBe("unknown");
  });

  it("decodes a task_started local_bash event", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_started",
      task_id: "task_abc",
      tool_use_id: "toolu_1",
      description: "next dev",
      task_type: "local_bash",
    });
    expect(getClaudeTaskDetails(ev)).toEqual({
      phase: "started",
      taskId: "task_abc",
      toolUseId: "toolu_1",
      taskType: "local_bash",
      subagentType: null,
      workflowName: null,
      description: "next dev",
      status: null,
      usage: null,
      outputFile: null,
      summary: null,
      endTime: null,
    });
  });

  it("decodes task_started subagent fields (subagent_type, workflow_name); task_type stays optional", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_started",
      task_id: "task_sub",
      tool_use_id: "toolu_2",
      description: "research the codebase",
      subagent_type: "Explore",
      workflow_name: "review-changes",
    });
    const t = getClaudeTaskDetails(ev)!;
    expect(t.phase).toBe("started");
    expect(t.subagentType).toBe("Explore");
    expect(t.workflowName).toBe("review-changes");
    expect(t.taskType).toBeNull();
    expect(t.status).toBeNull();
  });

  it("decodes task_progress usage (snake_case -> camelCase)", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      tool_use_id: "toolu_1",
      description: "running tests",
      usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
    });
    const t = getClaudeTaskDetails(ev)!;
    expect(t.phase).toBe("progress");
    expect(t.description).toBe("running tests");
    expect(t.usage).toEqual({ totalTokens: 1200, toolUses: 3, durationMs: 4500 });
    expect(t.status).toBeNull();
  });

  it("reads status/description/end_time out of task_updated's `patch` envelope", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_updated",
      task_id: "task_abc",
      patch: { status: "killed", description: "stopped by user", end_time: 1719200000000 },
    });
    const t = getClaudeTaskDetails(ev)!;
    expect(t.phase).toBe("updated");
    expect(t.taskId).toBe("task_abc");
    expect(t.status).toBe("killed");
    expect(t.description).toBe("stopped by user");
    expect(t.endTime).toBe(1719200000000);
    expect(t.toolUseId).toBeNull(); // task_updated carries no tool_use_id
  });

  it("decodes a terminal task_notification (3-value status enum)", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_notification",
      task_id: "task_abc",
      tool_use_id: "toolu_1",
      status: "stopped",
      output_file: "/tmp/task_abc.output",
      summary: "Server stopped",
      usage: { total_tokens: 50, tool_uses: 0, duration_ms: 12000 },
    });
    const t = getClaudeTaskDetails(ev)!;
    expect(t.phase).toBe("notification");
    expect(t.status).toBe("stopped");
    expect(t.outputFile).toBe("/tmp/task_abc.output");
    expect(t.summary).toBe("Server stopped");
    expect(t.usage).toEqual({ totalTokens: 50, toolUses: 0, durationMs: 12000 });
  });

  it("maps an out-of-range status to null (forward-compat; raw keeps the truth)", () => {
    const ev = parseOne({
      type: "system",
      subtype: "task_updated",
      task_id: "task_abc",
      patch: { status: "some_future_status" },
    });
    expect(getClaudeTaskDetails(ev)!.status).toBeNull();
  });

  it("returns null for a non-task unknown event", () => {
    const ev = parseOne({ type: "system", subtype: "compact_boundary" });
    expect(ev.type).toBe("unknown");
    expect(getClaudeTaskDetails(ev)).toBeNull();
  });

  it("returns null for a non-`unknown` event type (e.g. system init)", () => {
    const ev = parseOne({ type: "system", subtype: "init", session_id: "s", model: "claude" });
    expect(ev.type).toBe("system");
    expect(getClaudeTaskDetails(ev)).toBeNull();
  });

  it("returns null for a task-shaped event from a different provider", () => {
    const foreign: StreamEvent = {
      type: "unknown",
      subtype: "system",
      timestamp: new Date().toISOString(),
      providerType: "codex",
      sessionId: null,
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: { type: "system", subtype: "task_started", task_id: "x" },
    };
    expect(getClaudeTaskDetails(foreign)).toBeNull();
  });
});
