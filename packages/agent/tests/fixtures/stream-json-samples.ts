// Sample Claude stream-json output for testing

export const CLAUDE_SUCCESS_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-abc-123",
    model: "claude-sonnet-4-20250514",
  }),
  JSON.stringify({
    type: "assistant",
    session_id: "sess-abc-123",
    message: {
      content: [
        { type: "text", text: "Hello! I've completed the task." },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    session_id: "sess-abc-123",
    result: "Task completed successfully.",
    is_error: false,
    total_cost_usd: 0.0042,
    usage: {
      input_tokens: 150,
      output_tokens: 50,
      cache_read_input_tokens: 10,
    },
  }),
].join("\n");

export const CLAUDE_MAX_TURNS_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-max-turns",
    model: "claude-sonnet-4-20250514",
  }),
  JSON.stringify({
    type: "result",
    session_id: "sess-max-turns",
    subtype: "error_max_turns",
    result: "Hit max turns limit.",
    is_error: true,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 0,
    },
  }),
].join("\n");

export const CLAUDE_AUTH_REQUIRED_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "",
    model: "",
  }),
  "please log in by running `claude login`",
].join("\n");

export const CLAUDE_UNKNOWN_SESSION_OUTPUT = [
  JSON.stringify({
    type: "result",
    result: "no conversation found with session id sess-old-123",
    is_error: true,
  }),
].join("\n");

export const CLAUDE_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-malformed",
    model: "claude-sonnet-4-20250514",
  }),
  "{ broken json",
  JSON.stringify({
    type: "result",
    result: "Done despite bad lines.",
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  }),
].join("\n");

export const CLAUDE_TOOL_USE_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-tools",
    model: "claude-sonnet-4-20250514",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me read the file." },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.txt" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool-123", content: "file contents", is_error: false },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    result: "Done.",
    total_cost_usd: 0.005,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  }),
].join("\n");
