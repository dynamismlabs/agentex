#!/usr/bin/env node
// Mock agent script that mimics Claude/Codex CLI behavior for integration tests.
// Ignores all CLI args. Behavior controlled by MOCK_BEHAVIOR env var.
// Format controlled by MOCK_FORMAT env var: "claude" (default), "codex"

const behavior = process.env.MOCK_BEHAVIOR ?? "success";
const format = process.env.MOCK_FORMAT ?? "claude";

// Read stdin (prompt)
let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (format === "codex") {
    emitCodex();
  } else {
    emitClaude();
  }
});

function emitClaude() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-session-1", model: "claude-sonnet-4-20250514",
      }));
      console.log(JSON.stringify({
        type: "assistant", session_id: "mock-session-1",
        message: { content: [{ type: "text", text: "Processed: " + stdin.trim().slice(0, 50) }] },
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-session-1",
        result: "Done: " + stdin.trim().slice(0, 50),
        is_error: false, total_cost_usd: 0.0025,
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 5 },
      }));
      process.exit(0);
      break;

    case "max_turns":
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-mt-1", model: "claude-sonnet-4-20250514",
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-mt-1",
        subtype: "error_max_turns", result: "Hit max turns limit.", is_error: true,
        total_cost_usd: 0.01,
        usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0 },
      }));
      process.exit(1);
      break;

    case "auth_required":
      console.log("please log in by running `claude login`");
      process.exit(1);
      break;

    case "unknown_session":
      console.log(JSON.stringify({
        type: "result", result: "no conversation found with session id mock-old",
        is_error: true,
      }));
      process.exit(1);
      break;

    case "timeout":
      // Keep process alive — will be killed by timeout
      setInterval(() => {}, 60000);
      return;

    case "error":
      process.stderr.write("Something went wrong\n");
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}

function emitCodex() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "thread.started", thread_id: "codex-thread-1",
      }));
      console.log(JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: '/bin/bash -lc "echo hello"', status: "in_progress" },
      }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-mock-1", command: '/bin/bash -lc "echo hello"', aggregated_output: "hello", exit_code: 0, status: "completed" },
      }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", content: [{ type: "output_text", text: "Codex done: " + stdin.trim().slice(0, 50) }] },
      }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 80, output_tokens: 20 },
        model: "o4-mini",
      }));
      process.exit(0);
      break;

    case "auth_required":
      process.stderr.write("Error: OPENAI_API_KEY is not set\n");
      process.exit(1);
      break;

    case "timeout":
      setInterval(() => {}, 60000);
      return;

    case "error":
      console.log(JSON.stringify({
        type: "error", message: "Codex error occurred",
      }));
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}
