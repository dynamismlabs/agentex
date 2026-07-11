#!/usr/bin/env node
// Mock agent script that mimics Claude/Codex CLI behavior for integration tests.
// Ignores all CLI args. Behavior controlled by MOCK_BEHAVIOR env var.
// Format controlled by MOCK_FORMAT env var: "claude" (default), "codex", "gemini", "cursor", "opencode", "pi"
// When MOCK_DUMP_STDIN_TO is set, received stdin is written to that path before
// emitting — lets tests assert on the prompt.

import * as fs from "node:fs";

const behavior = process.env.MOCK_BEHAVIOR ?? "success";
const format = process.env.MOCK_FORMAT ?? "claude";
const dumpStdinTo = process.env.MOCK_DUMP_STDIN_TO;
const dumpArgsTo = process.env.MOCK_DUMP_ARGS_TO;

if (dumpArgsTo) {
  try { fs.appendFileSync(dumpArgsTo, JSON.stringify(process.argv.slice(2)) + "\n"); } catch { /* swallow */ }
}

const cliArgs = process.argv.slice(2);
if (format === "cursor" && ["supported", "models_only", "no_stream_json"].includes(process.env.MOCK_CURSOR_PROFILE)) {
  if (cliArgs.includes("--version")) {
    console.log("cursor-agent 2.0.0");
    process.exit(0);
  }
  if (cliArgs.includes("models")) {
    console.log(JSON.stringify({ models: ["gpt-5", "grok-4.5"] }));
    process.exit(0);
  }
  if (cliArgs.includes("--help")) {
    if (process.env.MOCK_CURSOR_PROFILE === "models_only") {
      console.log("Options:\n  --mode <agent|plan|ask>");
      process.exit(0);
    }
    if (process.env.MOCK_CURSOR_PROFILE === "no_stream_json") {
      console.log("Options:\n  -p, --print\n  --output-format <text|json>\n  --resume <chatId>\n  --mode <agent|plan|ask>");
      process.exit(0);
    }
    console.log("Options:\n  -p, --print\n  --output-format <text|json|stream-json>\n  --resume <chatId>\n  --mode <agent|plan|ask>");
    process.exit(0);
  }
}
if (format === "cursor" && cliArgs.includes("status") && process.env.MOCK_CURSOR_STATUS) {
  console.log(process.env.MOCK_CURSOR_STATUS);
  process.exit(0);
}

// Read stdin (prompt)
let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (dumpStdinTo) {
    try { fs.writeFileSync(dumpStdinTo, stdin); } catch { /* swallow */ }
  }
  if (format === "codex") {
    emitCodex();
  } else if (format === "gemini") {
    emitGemini();
  } else if (format === "cursor") {
    emitCursor();
  } else if (format === "opencode") {
    emitOpenCode();
  } else if (format === "pi") {
    emitPi();
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

function emitGemini() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-gemini-sess-1", model: "gemini-2.5-pro",
      }));
      console.log(JSON.stringify({
        type: "assistant", session_id: "mock-gemini-sess-1",
        message: { content: [{ type: "text", text: "Processed: " + stdin.trim().slice(0, 50) }] },
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-gemini-sess-1",
        result: "Done: " + stdin.trim().slice(0, 50),
        is_error: false, total_cost_usd: 0.003,
        usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 5 },
      }));
      process.exit(0);
      break;

    case "auth_required":
      process.stderr.write("Error: API key required\n");
      process.exit(1);
      break;

    case "timeout":
      setInterval(() => {}, 60000);
      return;

    case "error":
      console.log(JSON.stringify({
        type: "error", message: "Gemini error occurred",
      }));
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}

function emitCursor() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-cursor-sess-1", model: "gpt-4o",
      }));
      console.log(JSON.stringify({
        type: "assistant", session_id: "mock-cursor-sess-1",
        message: { content: [{ type: "text", text: "Processed: " + stdin.trim().slice(0, 50) }] },
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-cursor-sess-1",
        result: "Done: " + stdin.trim().slice(0, 50),
        is_error: false, total_cost_usd: 0.0025,
        usage: { input_tokens: 90, output_tokens: 25, cached_input_tokens: 3 },
        model: "gpt-4o",
      }));
      process.exit(0);
      break;

    case "unknown_then_success": {
      const stateFile = process.env.MOCK_ATTEMPT_FILE;
      if (stateFile && !fs.existsSync(stateFile)) {
        fs.writeFileSync(stateFile, "attempted");
        console.log(JSON.stringify({
          type: "result", result: "unknown session mock-old", is_error: true,
        }));
        process.exit(1);
      }
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-cursor-new", model: "gpt-4o",
      }));
      console.log(JSON.stringify({
        type: "assistant", session_id: "mock-cursor-new",
        message: { content: [{ type: "text", text: "Recovered" }] },
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-cursor-new", result: "Recovered",
        is_error: false, usage: {}, model: "gpt-4o",
      }));
      process.exit(0);
      break;
    }

    case "unknown_after_init":
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-old", model: "gpt-4o",
      }));
      console.log(JSON.stringify({
        type: "result", session_id: "mock-old", result: "unknown session mock-old", is_error: true,
      }));
      process.exit(1);
      break;

    case "bad_marker_order":
      console.log(JSON.stringify({
        type: "assistant", session_id: "mock-bad",
        message: { content: [{ type: "text", text: "too early" }] },
      }));
      console.log(JSON.stringify({
        type: "system", subtype: "init", session_id: "mock-bad", model: "gpt-4o",
      }));
      process.exit(0);
      break;

    case "auth_required":
      process.stderr.write("Error: CURSOR_API_KEY is not set\n");
      process.exit(1);
      break;

    case "timeout":
      setInterval(() => {}, 60000);
      return;

    case "error":
      console.log(JSON.stringify({
        type: "error", message: "Cursor error occurred",
      }));
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}

function emitOpenCode() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "text", sessionID: "mock-oc-sess-1",
        part: { text: "Processed: " + stdin.trim().slice(0, 50) },
      }));
      console.log(JSON.stringify({
        type: "step_finish", sessionID: "mock-oc-sess-1",
        part: {
          tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 5 } },
          cost: 0.003,
        },
      }));
      process.exit(0);
      break;

    case "auth_required":
      process.stderr.write("Error: API key required\n");
      process.exit(1);
      break;

    case "timeout":
      setInterval(() => {}, 60000);
      return;

    case "error":
      console.log(JSON.stringify({
        type: "error", message: "OpenCode error occurred",
      }));
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}

function emitPi() {
  switch (behavior) {
    case "success":
      console.log(JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Processed: " + stdin.trim().slice(0, 50) }],
          usage: { input: 80, output: 20, cacheRead: 5, cost: { total: 0.002 } },
        },
      }));
      console.log(JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "Done: " + stdin.trim().slice(0, 50) }] }],
      }));
      process.exit(0);
      break;

    case "auth_required":
      process.stderr.write("Error: authentication required\n");
      process.exit(1);
      break;

    case "timeout":
      setInterval(() => {}, 60000);
      return;

    case "error":
      console.log(JSON.stringify({
        type: "error", message: "Pi error occurred",
      }));
      process.exit(1);
      break;

    default:
      process.exit(1);
  }
}
