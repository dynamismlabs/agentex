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

/**
 * Real capture: `ANTHROPIC_API_KEY=bad claude --output-format stream-json -p hi`
 *
 * Two key lines: a synthetic-assistant message with `error:
 * "authentication_failed"`, followed by a `result` event with
 * `api_error_status: 401`. Use this to assert that the parser
 * suppresses the synthetic assistant and emits exactly one
 * `auth_required` event from the result branch.
 */
export const CLAUDE_AUTH_INVALID_API_KEY_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-bad-api-key",
    model: "claude-opus-4-7",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-synthetic-1",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "Invalid API key · Fix external API key" }],
    },
    session_id: "sess-bad-api-key",
    uuid: "uuid-asst-1",
    error: "authentication_failed",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 401,
    duration_ms: 178,
    num_turns: 1,
    result: "Invalid API key · Fix external API key",
    stop_reason: "stop_sequence",
    session_id: "sess-bad-api-key",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    terminal_reason: "completed",
  }),
].join("\n");

/**
 * Real capture: `claude --bare --output-format stream-json -p hi` with no
 * credentials. The CLI short-circuits before any HTTP call, so the result
 * event has `api_error_status: null` — but the documented user-facing
 * text "Not logged in · Please run /login" is still present. The parser
 * needs to fall back to text-match in this case.
 */
export const CLAUDE_AUTH_NOT_LOGGED_IN_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-not-logged-in",
    model: "claude-opus-4-7",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-synthetic-2",
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "Not logged in · Please run /login" }],
    },
    session_id: "sess-not-logged-in",
    uuid: "uuid-asst-2",
    error: "authentication_failed",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: null,
    result: "Not logged in · Please run /login",
    stop_reason: "stop_sequence",
    session_id: "sess-not-logged-in",
    total_cost_usd: 0,
    terminal_reason: "completed",
  }),
].join("\n");

/**
 * Documented OAuth-expired output (https://code.claude.com/docs/en/errors).
 * Same shape as INVALID_API_KEY but with the expired-token text — exercises
 * the `expired` reason classifier.
 */
export const CLAUDE_AUTH_OAUTH_EXPIRED_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-oauth-expired",
    model: "claude-opus-4-7",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-synthetic-3",
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "OAuth token has expired · Please run /login" }],
    },
    session_id: "sess-oauth-expired",
    uuid: "uuid-asst-3",
    error: "authentication_failed",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 401,
    result: "OAuth token has expired · Please run /login",
    stop_reason: "stop_sequence",
    session_id: "sess-oauth-expired",
    total_cost_usd: 0,
    terminal_reason: "completed",
  }),
].join("\n");

/** Bedrock bad-credential capture — exercises the `403 / "Failed to
 * authenticate"` path. */
export const CLAUDE_AUTH_BEDROCK_BAD_OUTPUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-bedrock-bad",
    model: "claude-opus-4-7",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-synthetic-4",
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "Failed to authenticate. API Error: 403 The security token included in the request is invalid." }],
    },
    session_id: "sess-bedrock-bad",
    uuid: "uuid-asst-4",
    error: "authentication_failed",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 403,
    result: "Failed to authenticate. API Error: 403 The security token included in the request is invalid.",
    stop_reason: "stop_sequence",
    session_id: "sess-bedrock-bad",
    total_cost_usd: 0,
    terminal_reason: "completed",
  }),
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
        { type: "tool_use", id: "toolu_01ABC123", name: "Read", input: { file_path: "/tmp/test.txt" } },
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
