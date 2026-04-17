// Sample Codex JSONL output for testing

export const CODEX_SUCCESS_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-xyz-1" }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      content: [{ type: "output_text", text: "Task completed by Codex." }],
    },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 80, output_tokens: 20 },
    model: "o4-mini",
  }),
].join("\n");

export const CODEX_AUTH_ERROR_OUTPUT = "";
export const CODEX_AUTH_STDERR = "Error: OPENAI_API_KEY is not set\n";

export const CODEX_ERROR_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-err-1" }),
  JSON.stringify({ type: "error", message: "Something went wrong" }),
].join("\n");

export const CODEX_TURN_FAILED_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-fail-1" }),
  JSON.stringify({ type: "turn.failed", message: "Turn failed due to error" }),
].join("\n");

export const CODEX_MALFORMED_OUTPUT = [
  "not valid json",
  JSON.stringify({ type: "thread.started", thread_id: "thread-mal-1" }),
  "{ broken",
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "o4-mini",
  }),
].join("\n");

export const CODEX_COMMAND_EXECUTION_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-cmd-1" }),
  JSON.stringify({
    type: "item.started",
    item: {
      type: "command_execution",
      command: '/bin/bash -lc "ls -la"',
      status: "in_progress",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "cmd-001",
      command: '/bin/bash -lc "ls -la"',
      aggregated_output: "total 42\ndrwxr-xr-x  5 user staff 160 Mar  5 10:00 .",
      exit_code: 0,
      status: "completed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      content: [{ type: "output_text", text: "Listed directory contents." }],
    },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 120, output_tokens: 40 },
    model: "o4-mini",
  }),
].join("\n");

export const CODEX_COMMAND_FAILURE_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-cmd-fail" }),
  JSON.stringify({
    type: "item.started",
    item: {
      type: "command_execution",
      command: '/bin/bash -lc "cat /nonexistent"',
      status: "in_progress",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "cmd-002",
      command: '/bin/bash -lc "cat /nonexistent"',
      aggregated_output: "cat: /nonexistent: No such file or directory",
      exit_code: 1,
      status: "completed",
    },
  }),
].join("\n");

export const CODEX_FUNCTION_CALL_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-fn-1" }),
  JSON.stringify({
    type: "item.started",
    item: {
      type: "function_call",
      id: "fc-001",
      name: "read_file",
      arguments: JSON.stringify({ path: "/tmp/test.txt" }),
      status: "in_progress",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "function_call",
      id: "fc-001",
      name: "read_file",
      arguments: JSON.stringify({ path: "/tmp/test.txt" }),
      output: "file contents here",
      status: "completed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      content: [{ type: "output_text", text: "Read the file for you." }],
    },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 35 },
    model: "o4-mini",
  }),
].join("\n");

export const CODEX_FUNCTION_CALL_FAILURE_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-fn-fail" }),
  JSON.stringify({
    type: "item.started",
    item: {
      type: "function_call",
      call_id: "fc-002",
      name: "write_file",
      input: { path: "/readonly/file.txt", content: "data" },
      status: "in_progress",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "function_call",
      call_id: "fc-002",
      name: "write_file",
      result: "Permission denied",
      status: "failed",
    },
  }),
].join("\n");

export const CODEX_ROLLOUT_NOISE = [
  "2025-01-01T00:00:00.000Z ERROR codex_core::rollout::list: state db missing rollout path for thread abc-123",
  "actual useful stderr output",
  "2025-02-02T00:00:00.000Z ERROR codex_core::rollout::list: state db missing rollout path for thread def-456",
].join("\n");
