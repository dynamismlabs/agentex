// Sample OpenCode JSONL output for testing

export const OPENCODE_SUCCESS_OUTPUT = [
  JSON.stringify({
    type: "text",
    sessionID: "oc-sess-1",
    part: { text: "Task completed successfully." },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "oc-sess-1",
    part: {
      tokens: {
        input: 200,
        output: 50,
        reasoning: 30,
        cache: { read: 10 },
      },
      cost: 0.0055,
    },
  }),
].join("\n");

export const OPENCODE_ERROR_OUTPUT = [
  JSON.stringify({
    type: "text",
    sessionID: "oc-sess-err",
    part: { text: "Attempting operation..." },
  }),
  JSON.stringify({
    type: "error",
    message: "Model request failed",
  }),
].join("\n");

export const OPENCODE_TOOL_USE_OUTPUT = [
  JSON.stringify({
    type: "tool_use",
    sessionID: "oc-sess-tool",
    part: {
      name: "bash",
      input: { command: "ls -la" },
      state: { status: "running" },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "oc-sess-tool",
    part: {
      tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 5 } },
      cost: 0.003,
    },
  }),
].join("\n");

export const OPENCODE_TOOL_ERROR_OUTPUT = [
  JSON.stringify({
    type: "tool_use",
    sessionID: "oc-sess-terr",
    part: {
      name: "bash",
      input: { command: "cat /nonexistent" },
      state: { status: "error", error: "Command failed with exit code 1" },
    },
  }),
].join("\n");

export const OPENCODE_UNKNOWN_SESSION_STDERR = "Error: unknown session oc-sess-old\n";

export const OPENCODE_AUTH_REQUIRED_STDERR = "Error: api key required\n";

export const OPENCODE_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({
    type: "text",
    sessionID: "oc-sess-mal",
    part: { text: "Done despite bad lines." },
  }),
  "{ broken json",
  JSON.stringify({
    type: "step_finish",
    sessionID: "oc-sess-mal",
    part: {
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0 } },
      cost: 0.001,
    },
  }),
].join("\n");

export const OPENCODE_REASONING_OUTPUT = [
  JSON.stringify({
    type: "step_finish",
    sessionID: "oc-sess-reason",
    part: {
      tokens: {
        input: 150,
        output: 40,
        reasoning: 60,
        cache: { read: 20 },
      },
      cost: 0.008,
    },
  }),
].join("\n");
