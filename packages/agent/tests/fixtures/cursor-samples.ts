// Sample Cursor stream-json output for testing

export const CURSOR_SUCCESS_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-sess-001",
    model: "cursor-fast",
  }),
  JSON.stringify({
    type: "assistant",
    session_id: "cursor-sess-001",
    message: {
      content: [
        { type: "text", text: "Changes applied successfully." },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    session_id: "cursor-sess-001",
    result: "Task completed.",
    is_error: false,
    total_cost_usd: 0.0045,
    usage: {
      input_tokens: 180,
      output_tokens: 55,
      cache_read_input_tokens: 12,
    },
  }),
].join("\n");

export const CURSOR_PREFIXED_OUTPUT = [
  'stdout: ' + JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-sess-pfx",
    model: "cursor-fast",
  }),
  'stdout: ' + JSON.stringify({
    type: "assistant",
    session_id: "cursor-sess-pfx",
    message: {
      content: [
        { type: "text", text: "Handled prefixed output." },
      ],
    },
  }),
  'stdout: ' + JSON.stringify({
    type: "result",
    session_id: "cursor-sess-pfx",
    result: "Done with prefix.",
    is_error: false,
    total_cost_usd: 0.003,
    usage: {
      input_tokens: 90,
      output_tokens: 30,
      cache_read_input_tokens: 0,
    },
  }),
].join("\n");

export const CURSOR_STEP_FINISH_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-sess-step",
    model: "cursor-fast",
  }),
  JSON.stringify({
    type: "text",
    part: { text: "Working on the task..." },
  }),
  JSON.stringify({
    type: "step_finish",
    part: {
      tokens: {
        input: 120,
        output: 40,
        cache: { read: 10 },
      },
      cost: 0.0032,
    },
  }),
].join("\n");

export const CURSOR_ERROR_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-sess-err",
    model: "cursor-fast",
  }),
  JSON.stringify({
    type: "error",
    message: "Rate limit exceeded",
  }),
].join("\n");

export const CURSOR_AUTH_REQUIRED_STDERR = "Error: CURSOR_API_KEY is not set\n";

export const CURSOR_UNKNOWN_SESSION_STDERR = "Error: unknown session cursor-sess-old\n";

export const CURSOR_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cursor-sess-mal",
    model: "cursor-fast",
  }),
  "{ broken json",
  JSON.stringify({
    type: "result",
    result: "Done despite bad lines.",
    is_error: false,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  }),
].join("\n");
