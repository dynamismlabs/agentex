// Sample Pi JSONL output for testing

export const PI_SUCCESS_OUTPUT = [
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "Task completed.",
    },
  }),
  JSON.stringify({
    type: "agent_end",
    messages: [
      { role: "user", content: "Do the task" },
      { role: "assistant", content: [{ type: "text", text: "Final answer from agent." }] },
    ],
  }),
  JSON.stringify({
    type: "usage",
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 10,
      costUsd: 0.004,
    },
  }),
].join("\n");

export const PI_MESSAGE_UPDATE_OUTPUT = [
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "Hello ",
    },
  }),
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "world!",
    },
  }),
  JSON.stringify({
    type: "agent_end",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Hello world! Final." }] },
    ],
  }),
].join("\n");

export const PI_TOOL_EXECUTION_OUTPUT = [
  JSON.stringify({
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "ls" },
  }),
  JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "tc-pi-001",
    result: "file1.txt\nfile2.txt",
    isError: false,
  }),
  JSON.stringify({
    type: "turn_end",
    message: {
      content: [{ type: "text", text: "Listed files." }],
      usage: {
        input: 80,
        output: 30,
        cacheRead: 5,
        cost: { total: 0.003 },
      },
    },
  }),
].join("\n");

export const PI_USAGE_EVENT_OUTPUT = [
  JSON.stringify({
    type: "usage",
    usage: {
      inputTokens: 200,
      outputTokens: 60,
      cachedInputTokens: 25,
      costUsd: 0.007,
    },
  }),
].join("\n");

export const PI_ERROR_OUTPUT = [
  JSON.stringify({
    type: "error",
    message: "Pi agent encountered an error",
  }),
].join("\n");

export const PI_UNKNOWN_SESSION_STDERR = "Error: session not found for pi-sess-old\n";

export const PI_SKIPPED_RPC_OUTPUT = [
  JSON.stringify({
    type: "response",
    id: "rpc-1",
    result: {},
  }),
  JSON.stringify({
    type: "extension_ui_request",
    name: "render",
    params: {},
  }),
  JSON.stringify({
    type: "extension_ui_response",
    id: "resp-1",
    result: {},
  }),
  JSON.stringify({
    type: "extension_error",
    code: 500,
    message: "extension failed",
  }),
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "Actual content.",
    },
  }),
].join("\n");

export const PI_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "Survived malformed.",
    },
  }),
  "{ broken json",
].join("\n");
