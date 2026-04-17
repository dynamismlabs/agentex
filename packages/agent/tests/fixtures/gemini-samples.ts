// Sample Gemini stream-json output for testing

export const GEMINI_SUCCESS_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-001",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "assistant",
    session_id: "gemini-sess-001",
    message: {
      content: [
        { type: "text", text: "I've completed the requested task." },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    session_id: "gemini-sess-001",
    result: "Task completed successfully.",
    is_error: false,
    total_cost_usd: 0.0038,
    usage: {
      input_tokens: 200,
      output_tokens: 60,
      cached_input_tokens: 15,
    },
  }),
].join("\n");

export const GEMINI_CHECKPOINT_ID_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    checkpoint_id: "chk-abc-789",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "assistant",
    checkpoint_id: "chk-abc-789",
    message: {
      content: [
        { type: "text", text: "Resumed from checkpoint." },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    checkpoint_id: "chk-abc-789",
    result: "Resumed task done.",
    is_error: false,
    total_cost_usd: 0.002,
    usage: {
      input_tokens: 100,
      output_tokens: 30,
      cached_input_tokens: 50,
    },
  }),
].join("\n");

export const GEMINI_USAGE_METADATA_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-meta",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "assistant",
    session_id: "gemini-sess-meta",
    message: {
      content: [
        { type: "text", text: "Completed with Google-style usage." },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    session_id: "gemini-sess-meta",
    result: "Done.",
    is_error: false,
    total_cost_usd: 0.005,
    usageMetadata: {
      promptTokenCount: 180,
      candidatesTokenCount: 45,
      cachedContentTokenCount: 20,
    },
  }),
].join("\n");

export const GEMINI_ERROR_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-err",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "error",
    message: "Internal server error occurred",
  }),
].join("\n");

export const GEMINI_AUTH_REQUIRED_STDERR = "Error: API key required. Please set GEMINI_API_KEY.\n";

export const GEMINI_UNKNOWN_SESSION_STDERR = "Error: unknown session gemini-sess-old\n";

export const GEMINI_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-mal",
    model: "gemini-2.5-pro",
  }),
  "{ broken json",
  JSON.stringify({
    type: "result",
    result: "Done despite bad lines.",
    is_error: false,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
  }),
].join("\n");

export const GEMINI_TOOL_USE_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-tools",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me read the file for you." },
        { type: "tool_use", id: "tool-gem-call-001", name: "Read", input: { file_path: "/tmp/example.txt" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool-gem-001", content: "file contents here", is_error: false },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    result: "File read successfully.",
    is_error: false,
    total_cost_usd: 0.006,
    usage: { input_tokens: 150, output_tokens: 70, cached_input_tokens: 0 },
  }),
].join("\n");

export const GEMINI_TEXT_EVENTS_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-sess-text",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "text",
    part: { text: "First chunk of text." },
  }),
  JSON.stringify({
    type: "text",
    part: { text: "Second chunk of text." },
  }),
  JSON.stringify({
    type: "step_finish",
    usage: { input_tokens: 80, output_tokens: 25, cached_input_tokens: 5 },
  }),
].join("\n");
