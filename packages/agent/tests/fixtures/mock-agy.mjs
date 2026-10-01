#!/usr/bin/env node
// Mock Antigravity CLI (`agy`) speaking the documented headless protocol:
// `--input-format stream-json --output-format stream-json`, one NDJSON user
// message per stdin line, `init` once, `step_update`s, one `result` per turn.
// https://antigravity.google/docs/cli/headless
//
// MOCK_AGY_BEHAVIOR: success (default) | tool | thinking | error | denied |
//   auth | slow | crash | interrupt-exit | waiting | silent-exit |
//   silent-exit-once (with MOCK_AGY_STATE: a file counting spawns)
// MOCK_AGY_DELAY_MS: per-turn delay for `slow` (default 10000)
// MOCK_AGY_AUTH=missing: `models` reports no sign-in
// MOCK_AGY_HELP=old: `--help` without stream-json input support
// MOCK_DUMP_ARGS_TO: append argv (JSON) per spawn
// MOCK_DUMP_STDIN_TO: append each stdin line
// MOCK_PID_FILE: write this process's pid

import * as fs from "node:fs";

const args = process.argv.slice(2);
const behavior = process.env.MOCK_AGY_BEHAVIOR ?? "success";

if (process.env.MOCK_DUMP_ARGS_TO) fs.appendFileSync(process.env.MOCK_DUMP_ARGS_TO, `${JSON.stringify(args)}\n`);
if (process.env.MOCK_PID_FILE) fs.writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));

const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

if (args.includes("--version")) {
  console.log("1.2.14");
  process.exit(0);
}

if (args.includes("--help")) {
  const lines = [
    "Usage of agy:",
    "  --conversation                  Resume a previous conversation by ID",
    "  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting",
    "  --effort                        Reasoning effort for the current CLI session (low|medium|high|max)",
    "  --mode                          Set the agent execution mode for this session (accept-edits, plan)",
    "  --model                         Model for the current CLI session",
    "  --output-format                 Output format for print mode (text, json, stream-json) (default text)",
  ];
  if (process.env.MOCK_AGY_HELP !== "old") {
    lines.push("  --input-format                  Input format for print mode (text, stream-json).");
  }
  console.log(lines.join("\n"));
  process.exit(0);
}

if (args[0] === "models") {
  if (args.includes("--output-format")) {
    process.stderr.write("Usage: agy models [flags]\n\nError: flags provided but not defined: -output-format\n");
    process.exit(2);
  }
  process.stderr.write("Fetching available models...\n");
  if (process.env.MOCK_AGY_AUTH === "missing") {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  console.log([
    "gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
    "gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
    "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
  ].join("\n"));
  process.exit(0);
}

if (flag("--input-format") !== "stream-json" || flag("--output-format") !== "stream-json") {
  process.stderr.write("error: mock-agy only supports --input-format stream-json --output-format stream-json\n");
  process.exit(1);
}

const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (behavior === "auth") {
  process.stderr.write("Authentication required. Please visit the URL to log in:\n");
  process.stderr.write("  https://accounts.google.com/o/oauth2/auth?client_id=mock\n\n");
  process.stderr.write("Waiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:\n");
  setTimeout(() => {
    write({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } });
    process.exit(1);
  }, 60_000);
} else {
  run();
}

function run() {
  const requested = flag("--conversation");
  let conversationId = requested && requested !== "missing" ? requested : `mock-conv-${process.pid}`;
  if (requested === "missing") process.stderr.write(`warning: conversation ${requested} not found; starting a new conversation\n`);
  const model = flag("--model");
  const mode = flag("--mode");
  const permissionMode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";

  let step = 0;
  let turns = 0;
  let duration = 0;
  const usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
  let initSent = false;
  let queue = Promise.resolve();
  let inTurn = false;

  process.on("SIGINT", () => {
    if (!inTurn) process.exit(130);
    write({ event: "result", result: { conversation_id: conversationId, status: "INTERRUPTED", response: "", duration_seconds: duration, num_turns: turns, usage } });
    if (behavior === "interrupt-exit") process.exit(130);
    inTurn = false;
  });

  const stepUpdate = (fields) => write({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });

  const turn = async (content) => {
    // Exit on the first message without a word, like a process already shutting down.
    if (behavior === "silent-exit") process.exit(0);
    if (behavior === "silent-exit-once") {
      const state = process.env.MOCK_AGY_STATE;
      const spawns = state && fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
      if (state) fs.writeFileSync(state, String(spawns + 1));
      if (spawns === 0) process.exit(0);
    }
    if (!initSent) {
      initSent = true;
      write({
        event: "init",
        conversation_id: conversationId,
        init: {
          cwd: process.cwd(),
          tools: ["run_command", "write_to_file", "view_file"],
          permission_mode: permissionMode,
          ...(model ? { model } : {}),
          ...(mode ? { mode } : {}),
        },
      });
    }
    inTurn = true;
    turns += 1;
    stepUpdate({ step_index: step++, state: "DONE", step_type: "user_input" });

    if (behavior === "crash") {
      process.stderr.write("panic: mock crash\n");
      process.exit(2);
    }
    if (behavior === "slow" || behavior === "interrupt-exit") {
      await sleep(Number(process.env.MOCK_AGY_DELAY_MS ?? 10_000));
      if (!inTurn) return;
    }
    if (behavior === "tool") {
      const index = step++;
      stepUpdate({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } });
      stepUpdate({ step_index: index, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: 0.07, tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\r\n" } });
      const failed = step++;
      stepUpdate({ step_index: failed, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/nope" }, error: { type: "NOT_FOUND", message: "no such file" } } });
    }
    if (behavior === "thinking") {
      const index = step++;
      stepUpdate({ step_index: index, state: "ACTIVE", step_type: "agent_response", thinking_delta: "Let me " });
      stepUpdate({ step_index: index, state: "ACTIVE", step_type: "agent_response", thinking_delta: "think." });
      stepUpdate({ step_index: index, state: "DONE", step_type: "agent_response", text_delta: "thought-through" });
    }

    usage.input_tokens += 100;
    usage.output_tokens += 10;
    usage.thinking_tokens += 4;
    usage.cache_read_tokens += turns > 1 ? 80 : 0;
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    duration += 1.5;

    if (behavior === "error") {
      process.stderr.write(`AGY_ERROR: ${JSON.stringify({ status: "RESOURCE_EXHAUSTED", code: 429, retryable: true, message: "Quota exceeded for model" })}\n`);
      write({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error: "Quota exceeded for model", duration_seconds: duration, num_turns: turns, usage } });
      inTurn = false;
      return;
    }
    if (behavior === "waiting") {
      write({ event: "result", result: { conversation_id: conversationId, status: "WAITING", response: "", duration_seconds: duration, num_turns: turns, usage } });
      inTurn = false;
      return;
    }

    const reply = behavior === "thinking" ? "thought-through" : `echo: ${content}`;
    const index = step++;
    const half = Math.ceil(reply.length / 2);
    stepUpdate({ step_index: index, state: "ACTIVE", step_type: "agent_response", text_delta: reply.slice(0, half) });
    if (behavior !== "thinking") {
      stepUpdate({ step_index: index, state: "DONE", step_type: "agent_response", text_delta: `${reply.slice(half)}\n`, duration_seconds: 1.2, usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 0, total_tokens: 110 } });
    }
    stepUpdate({ step_index: step++, state: "DONE", step_type: "checkpoint", duration_seconds: 0.5 });
    stepUpdate({ step_index: step++, state: "DONE", step_type: "future_step_kind" });
    const denied = behavior === "denied" ? { denied_actions: [{ tool: "run_command", target: "rm -rf /tmp/x" }] } : {};
    write({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: `${reply}\n`, duration_seconds: duration, num_turns: turns, usage, ...denied } });
    inTurn = false;
  };

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (process.env.MOCK_DUMP_STDIN_TO) fs.appendFileSync(process.env.MOCK_DUMP_STDIN_TO, `${line}\n`);
      const message = JSON.parse(line);
      if (message.event !== "user") {
        process.stderr.write(`warning: ignoring unsupported stream input message event "${message.event}"\n`);
        continue;
      }
      const content = typeof message.message.content === "string"
        ? message.message.content
        : message.message.content.map((block) => block.text).join("");
      queue = queue.then(() => turn(content));
    }
  });
  process.stdin.on("end", () => {
    queue.then(() => process.exit(0));
  });
}
