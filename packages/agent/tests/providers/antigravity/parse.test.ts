import { describe, expect, it } from "vitest";
import {
  AgyStreamParser,
  agyUsageRecord,
  classifyAgyFailure,
  isAgyAuthRequired,
  mapAgyExecutionStatus,
  mapAgyTurnStatus,
  parseAgyErrorLine,
  parseAgyStreamJson,
  type AgyResult,
} from "../../../src/providers/antigravity/parse.js";

// Verbatim from https://antigravity.google/docs/cli/headless (Streaming JSON).
const DOCS_SINGLE_TURN = [
  `{"event":"init","conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","init":{"cwd":"/home/user/project","tools":["ask_permission","run_command","write_to_file","..."],"permission_mode":"request-review"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Git rebase destructively rewrites a branch's commit history by systematically detaching its unique commits and sequentially reapplying them onto a new base commit.\\n","duration_seconds":6.28,"usage":{"input_tokens":10302,"output_tokens":582,"thinking_tokens":551,"cache_read_tokens":8113,"total_tokens":10884}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.53,"usage":{"input_tokens":116,"output_tokens":7,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":123}}}`,
  `{"event":"result","result":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","status":"SUCCESS","response":"Git rebase destructively rewrites a branch's commit history by systematically detaching its unique commits and sequentially reapplying them onto a new base commit.\\n","duration_seconds":6.88,"num_turns":1,"usage":{"input_tokens":10418,"output_tokens":589,"thinking_tokens":551,"cache_read_tokens":8113,"total_tokens":11007}}}`,
].join("\n");

// Verbatim two-turn streaming session from the same page.
const DOCS_TWO_TURNS = [
  `{"event":"init","conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","init":{"cwd":"/home/user/project","tools":["ask_permission","run_command","write_to_file","..."],"permission_mode":"request-review"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"apple"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":1.169607627,"usage":{"input_tokens":30384,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":30388}}}`,
  `{"event":"result","result":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","status":"SUCCESS","response":"apple\\n","duration_seconds":1.427806958,"num_turns":1,"usage":{"input_tokens":30384,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":30388}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","step_index":3,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"apple\\n","duration_seconds":0.895679386,"usage":{"input_tokens":278,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":30214,"total_tokens":282}}}`,
  `{"event":"result","result":{"conversation_id":"9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f","status":"SUCCESS","response":"apple\\n","duration_seconds":2.548755756,"num_turns":2,"usage":{"input_tokens":30662,"output_tokens":8,"thinking_tokens":0,"cache_read_tokens":30214,"total_tokens":30670}}}`,
].join("\n");

// Verbatim tool step from the docs ("Tool calls in the stream").
const DOCS_TOOL_STEP = `{"event":"step_update","step_update":{"conversation_id":"edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.07,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_headless_demo"},"output":"hello_headless_demo\\r\\n"}}}`;

describe("AgyStreamParser — documented wire format", () => {
  it("maps a single-turn run to init, assistant, and result events", () => {
    const { events, results, conversationId } = parseAgyStreamJson(DOCS_SINGLE_TURN);
    expect(conversationId).toBe("c3b66b04-872b-4fbe-a3a4-058a026ef20a");
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"]);

    const init = events[0]!;
    expect(init).toMatchObject({
      type: "system",
      subtype: "init",
      cwd: "/home/user/project",
      tools: ["ask_permission", "run_command", "write_to_file", "..."],
      permissionMode: "request-review",
      model: null,
      providerType: "antigravity",
      sessionId: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
    });

    const assistant = events[1]!;
    expect(assistant.type === "assistant" && assistant.text).toMatch(/^Git rebase destructively rewrites/);
    expect(assistant.messageId).toBe("c3b66b04-872b-4fbe-a3a4-058a026ef20a:3");

    expect(events[2]).toMatchObject({
      type: "result",
      isError: false,
      terminalReason: "success",
      numTurns: 1,
      durationMs: 6880,
      costUsd: null,
    });

    const [result] = results;
    expect(result).toMatchObject({
      status: "SUCCESS",
      numTurns: 1,
      usage: { inputTokens: 10418, outputTokens: 589, thinkingTokens: 551, cacheReadTokens: 8113, totalTokens: 11007 },
      turnUsage: { inputTokens: 10418, outputTokens: 589, cacheReadTokens: 8113 },
    });
    expect(result!.response).toMatch(/new base commit\.\n$/);
  });

  it("joins ACTIVE text deltas with the DONE fragment and reports one assistant event per step", () => {
    const { events } = parseAgyStreamJson(DOCS_TWO_TURNS);
    const assistant = events.filter((e) => e.type === "assistant");
    expect(assistant.map((e) => e.type === "assistant" && e.text)).toEqual(["apple\n", "apple\n"]);
  });

  it("turns the session-cumulative usage and duration into per-turn deltas", () => {
    const { results } = parseAgyStreamJson(DOCS_TWO_TURNS);
    expect(results).toHaveLength(2);
    expect(results[0]!.turnUsage).toEqual({ inputTokens: 30384, outputTokens: 4, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 30388 });
    expect(results[1]!.turnUsage).toEqual({ inputTokens: 278, outputTokens: 4, thinkingTokens: 0, cacheReadTokens: 30214, totalTokens: 282 });
    expect(results[1]!.usage?.inputTokens).toBe(30662);
    expect(results[0]!.turnDurationMs).toBe(1428);
    expect(results[1]!.turnDurationMs).toBe(1121);
    expect(results[1]!.numTurns).toBe(2);
  });

  it("emits assistant_delta fragments only when partial messages are requested", () => {
    const plain = parseAgyStreamJson(DOCS_TWO_TURNS).events;
    expect(plain.some((e) => e.type === "assistant_delta")).toBe(false);

    const partial = parseAgyStreamJson(DOCS_TWO_TURNS, { includePartialMessages: true }).events;
    const deltas = partial.filter((e) => e.type === "assistant_delta");
    expect(deltas.map((e) => e.type === "assistant_delta" && e.text)).toEqual(["apple", "\n", "apple\n"]);
    // Deltas share the messageId of the consolidated assistant event.
    const firstAssistant = partial.find((e) => e.type === "assistant")!;
    expect(deltas[0]!.messageId).toBe(firstAssistant.messageId);
  });

  it("maps a completed tool step to a correlated tool_call + tool_result pair", () => {
    const parser = new AgyStreamParser();
    const { events } = parser.parseLine(DOCS_TOOL_STEP);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool_call",
      toolCallId: "edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3:4",
      name: "run_command",
      input: { CommandLine: "echo hello_headless_demo" },
    });
    expect(events[1]).toMatchObject({
      type: "tool_result",
      toolCallId: "edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3:4",
      toolName: "run_command",
      content: "hello_headless_demo\r\n",
      isError: false,
      exitCode: null,
    });
  });
});

describe("AgyStreamParser — step lifecycle", () => {
  const step = (fields: Record<string, unknown>) =>
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv", ...fields } });

  it("opens a tool call on ACTIVE and closes it once on DONE", () => {
    const parser = new AgyStreamParser();
    const active = parser.parseLine(step({ step_index: 7, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" } } }));
    expect(active.events.map((e) => e.type)).toEqual(["tool_call"]);
    const again = parser.parseLine(step({ step_index: 7, state: "ACTIVE", step_type: "tool", tool_name: "run_command" }));
    expect(again.events).toEqual([]);
    const done = parser.parseLine(step({ step_index: 7, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { output: "a\nb" } }));
    expect(done.events.map((e) => e.type)).toEqual(["tool_result"]);
  });

  it("marks a tool step with an error object as a failed result", () => {
    const parser = new AgyStreamParser();
    const { events } = parser.parseLine(step({
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "view_file",
      tool_info: { name: "view_file", parameters: { AbsolutePath: "/nope" }, error: { type: "NOT_FOUND", message: "no such file" } },
    }));
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true, content: "no such file" });
  });

  it("reports subagent steps as a tool call named subagent", () => {
    const parser = new AgyStreamParser();
    const subagentInfo = { subagents: [{ type_name: "researcher", role: "docs", conversation_id: "child-1", log_uri: "file:///log" }] };
    const { events } = parser.parseLine(step({ step_index: 5, state: "DONE", step_type: "subagent", subagent_info: subagentInfo }));
    expect(events[0]).toMatchObject({ type: "tool_call", name: "subagent", input: subagentInfo });
    expect(events[1]).toMatchObject({ type: "tool_result", toolName: "subagent" });
    expect(events[1]!.type === "tool_result" && JSON.parse(events[1]!.content)).toEqual(subagentInfo);
  });

  it("drops user_input and checkpoint steps, and surfaces unknown step types once", () => {
    const parser = new AgyStreamParser();
    expect(parser.parseLine(step({ step_index: 0, state: "DONE", step_type: "user_input" })).events).toEqual([]);
    expect(parser.parseLine(step({ step_index: 1, state: "DONE", step_type: "checkpoint" })).events).toEqual([]);
    expect(parser.parseLine(step({ step_index: 2, state: "ACTIVE", step_type: "browser_action" })).events).toEqual([]);
    expect(parser.parseLine(step({ step_index: 2, state: "DONE", step_type: "browser_action" })).events).toMatchObject([
      { type: "unknown", subtype: "browser_action" },
    ]);
  });

  it("surfaces thinking fragments as thinking events when a build sends them", () => {
    const parser = new AgyStreamParser({ includePartialMessages: true });
    const a = parser.parseLine(step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", thinking_delta: "Let me " }));
    const b = parser.parseLine(step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", thinking_delta: "think." }));
    const c = parser.parseLine(step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "Done." }));
    expect([...a.events, ...b.events].map((e) => e.type)).toEqual(["thinking_delta", "thinking_delta"]);
    expect(c.events.map((e) => e.type)).toEqual(["thinking", "assistant_delta", "assistant"]);
    expect(c.events[0]).toMatchObject({ type: "thinking", text: "Let me think." });
  });

  it("skips non-JSON lines and reports unknown top-level events for forward compatibility", () => {
    const parser = new AgyStreamParser();
    expect(parser.parseLine("warning: something on stdout").events).toEqual([]);
    expect(parser.parseLine("").events).toEqual([]);
    expect(parser.parseLine(`{"event":"future_thing","future_thing":{}}`).events).toMatchObject([
      { type: "unknown", subtype: "future_thing" },
    ]);
  });

  it("keeps a resumed conversation id until the stream reports one", () => {
    const parser = new AgyStreamParser({ conversationId: "resumed" });
    const { events } = parser.parseLine(`{"event":"future_thing"}`);
    expect(events[0]!.sessionId).toBe("resumed");
    parser.parseLine(step({ conversation_id: "fresh", step_index: 0, state: "DONE", step_type: "user_input" }));
    expect(parser.conversationId).toBe("fresh");
  });

  it("reads the pinned model and denied actions", () => {
    const parser = new AgyStreamParser();
    parser.parseLine(`{"event":"init","conversation_id":"c","init":{"model":"gemini-3.1-pro-high","permission_mode":"always-proceed"}}`);
    expect(parser.model).toBe("gemini-3.1-pro-high");
    expect(parser.permissionMode).toBe("always-proceed");
    const { result } = parser.parseLine(`{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"ok","denied_actions":[{"tool":"run_command"}]}}`);
    expect(result!.deniedActions).toEqual([{ tool: "run_command" }]);
  });
});

describe("agy error, status, and usage helpers", () => {
  it("parses AGY_ERROR stderr lines", () => {
    const report = parseAgyErrorLine(`AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":true,"message":"Quota exceeded"}`);
    expect(report).toMatchObject({ status: "RESOURCE_EXHAUSTED", code: 429, retryable: true, message: "Quota exceeded" });
    expect(parseAgyErrorLine("error: something else")).toBeNull();
    expect(parseAgyErrorLine("AGY_ERROR: not-json")).toBeNull();
  });

  it("recognizes every sign-in prompt the CLI prints", () => {
    expect(isAgyAuthRequired("Authentication required. Please visit the URL to log in:")).toBe(true);
    expect(isAgyAuthRequired("Error: Please sign in to view available models.")).toBe(true);
    expect(isAgyAuthRequired("authentication failed or timed out")).toBe(true);
    expect(isAgyAuthRequired("Fetching available models...")).toBe(false);
  });

  it("classifies failures from the result and the AGY_ERROR report", () => {
    const result = (fields: Partial<AgyResult>): AgyResult => ({
      status: "ERROR",
      response: "",
      error: null,
      conversationId: null,
      numTurns: null,
      turnDurationMs: null,
      usage: null,
      turnUsage: null,
      deniedActions: null,
      structuredOutput: undefined,
      raw: {},
      ...fields,
    });
    expect(classifyAgyFailure(result({ error: "authentication failed or timed out" }), null)).toBe("auth_required");
    expect(classifyAgyFailure(result({}), { message: null, status: "RESOURCE_EXHAUSTED", code: 429, retryable: true, raw: {} })).toBe("rate_limited");
    expect(classifyAgyFailure(result({ error: 'invalid model selection (--model "x")' }), null)).toBe("invalid_model");
    expect(classifyAgyFailure(result({ status: "WAITING" }), null)).toBe("waiting_for_input");
    expect(classifyAgyFailure(result({ error: "boom" }), null)).toBe("agent_error");
  });

  it("maps every documented status", () => {
    expect(mapAgyExecutionStatus("SUCCESS")).toBe("completed");
    expect(mapAgyExecutionStatus("CANCELED")).toBe("aborted");
    expect(mapAgyExecutionStatus("INTERRUPTED")).toBe("aborted");
    expect(mapAgyExecutionStatus("WAITING")).toBe("blocked");
    expect(mapAgyExecutionStatus("ERROR")).toBe("failed");
    expect(mapAgyExecutionStatus("INVALID")).toBe("failed");
    expect(mapAgyExecutionStatus("RUNNING")).toBe("failed");
    expect(mapAgyTurnStatus("WAITING")).toBe("failed");
    expect(mapAgyTurnStatus("INTERRUPTED")).toBe("aborted");
  });

  it("keys usage by model and drops empty usage", () => {
    const usage = { inputTokens: 10, outputTokens: 2, thinkingTokens: 1, cacheReadTokens: 4, totalTokens: 12 };
    expect(agyUsageRecord(usage, "gemini-3.1-pro-high")).toEqual({
      "gemini-3.1-pro-high": { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
    });
    expect(agyUsageRecord(usage, null)).toEqual({ default: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 } });
    expect(agyUsageRecord({ ...usage, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, null)).toBeUndefined();
    expect(agyUsageRecord(null, null)).toBeUndefined();
  });
});
