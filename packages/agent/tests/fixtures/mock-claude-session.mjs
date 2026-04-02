#!/usr/bin/env node
// Mock Claude CLI in stream-json session mode.
// Reads ndjson from stdin, responds to control_request and user messages.
// Stays alive until stdin closes.
//
// Special trigger messages:
//   "test-permissions"    — sends a can_use_tool request before the result
//   "test-elicitation"   — sends an elicitation request before the result
//   "test-ask-question"  — sends a can_use_tool for AskUserQuestion
//   "test-hook"          — sends a hook_callback request before the result
//   "test-cancel"        — sends a can_use_tool then immediately cancels it
//   anything else        — responds directly with a result

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const SESSION_ID = "mock-session-" + randomUUID().slice(0, 8);
let turnCount = 0;

/** Pending control requests — keyed by request_id */
const pendingRequests = new Map();

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendControlRequest(subtype, request) {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    write({
      type: "control_request",
      request_id: requestId,
      request: { subtype, ...request },
    });
  });
}

function emitResult(snippet, extra = {}) {
  write({
    type: "result",
    subtype: "success",
    session_id: SESSION_ID,
    result: `[turn ${turnCount}] Done: ${snippet}`,
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0.0025 * turnCount,
    usage: {
      input_tokens: 100 * turnCount,
      output_tokens: 30 * turnCount,
      cache_read_input_tokens: 5 * turnCount,
    },
    ...extra,
  });
}

function emitAssistant(text) {
  write({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      content: [{ type: "text", text }],
    },
  });
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const type = msg.type;

  // ---------------------------------------------------------------------------
  // Control responses from the host — resolve pending promises
  // ---------------------------------------------------------------------------
  if (type === "control_response") {
    const requestId = msg.response?.request_id;
    if (requestId && pendingRequests.has(requestId)) {
      const resolve = pendingRequests.get(requestId);
      pendingRequests.delete(requestId);
      resolve(msg.response);
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Control requests from the host (interrupt, etc.)
  // ---------------------------------------------------------------------------
  if (type === "control_request") {
    const subtype = msg.request?.subtype;
    const requestId = msg.request_id;

    if (subtype === "initialize") {
      write({
        type: "control_response",
        response: {
          request_id: requestId,
          subtype: "success",
          response: { commands: [], agents: [], models: [] },
        },
      });
      return;
    }

    if (subtype === "interrupt") {
      emitResult("Interrupted.", { stop_reason: "interrupt" });
      return;
    }

    // Unknown — ack it
    write({
      type: "control_response",
      response: { request_id: requestId, subtype: "success", response: {} },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // User messages — simulate turns with optional control request triggers
  // ---------------------------------------------------------------------------
  if (type === "user") {
    turnCount++;
    const content = msg.message?.content ?? "";
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const snippet = text.slice(0, 80);

    // Emit system init on first turn
    if (turnCount === 1) {
      write({
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        model: "claude-sonnet-4-20250514",
      });
    }

    // --- Trigger: can_use_tool permission ---
    if (text.includes("test-permissions")) {
      const resp = await sendControlRequest("can_use_tool", {
        tool_name: "Bash",
        input: { command: "echo hello" },
        tool_use_id: "tool_" + randomUUID().slice(0, 8),
        title: "Run shell command",
        description: "Execute echo hello",
      });
      emitAssistant(`[turn ${turnCount}] Permission response: ${JSON.stringify(resp.response)}`);
      emitResult(snippet);
      return;
    }

    // --- Trigger: AskUserQuestion (structured choices) ---
    if (text.includes("test-ask-question")) {
      const resp = await sendControlRequest("can_use_tool", {
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Pick a color",
              header: "Color selection",
              options: [
                { label: "Red", description: "A warm color" },
                { label: "Blue", description: "A cool color" },
                { label: "Green", description: "A natural color" },
              ],
            },
          ],
        },
        tool_use_id: "tool_" + randomUUID().slice(0, 8),
      });
      const answers = resp.response?.updatedInput?.answers ?? {};
      emitAssistant(`[turn ${turnCount}] User chose: ${JSON.stringify(answers)}`);
      emitResult(snippet);
      return;
    }

    // --- Trigger: AskUserQuestion multi-select ---
    if (text.includes("test-ask-multiselect")) {
      const resp = await sendControlRequest("can_use_tool", {
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which toppings?",
              header: "Pizza toppings",
              multiSelect: true,
              options: [
                { label: "Pepperoni", description: "Classic meat" },
                { label: "Mushrooms", description: "Earthy and savory" },
                { label: "Jalapeños", description: "Spicy kick" },
                { label: "Pineapple", description: "Controversial" },
              ],
            },
          ],
        },
        tool_use_id: "tool_" + randomUUID().slice(0, 8),
      });
      const answers = resp.response?.updatedInput?.answers ?? {};
      emitAssistant(`[turn ${turnCount}] User chose: ${JSON.stringify(answers)}`);
      emitResult(snippet);
      return;
    }

    // --- Trigger: elicitation ---
    if (text.includes("test-elicitation")) {
      const resp = await sendControlRequest("elicitation", {
        mcp_server_name: "mock-server",
        message: "Choose your framework",
        mode: "form",
        elicitation_id: "elicit_" + randomUUID().slice(0, 8),
        requested_schema: {
          type: "object",
          properties: {
            framework: {
              type: "string",
              oneOf: [
                { const: "express", title: "Express" },
                { const: "fastify", title: "Fastify" },
              ],
            },
            notes: { type: "string" },
          },
          required: ["framework"],
        },
      });
      emitAssistant(`[turn ${turnCount}] Elicitation response: ${JSON.stringify(resp.response)}`);
      emitResult(snippet);
      return;
    }

    // --- Trigger: hook_callback ---
    if (text.includes("test-hook")) {
      const resp = await sendControlRequest("hook_callback", {
        callback_id: "hook_" + randomUUID().slice(0, 8),
        input: { event: "pre_tool_use", tool_name: "Bash" },
      });
      emitAssistant(`[turn ${turnCount}] Hook response: ${JSON.stringify(resp.response)}`);
      emitResult(snippet);
      return;
    }

    // --- Trigger: cancel a pending request ---
    if (text.includes("test-cancel")) {
      const requestId = randomUUID();
      // Send a can_use_tool request
      pendingRequests.set(requestId, () => {});
      write({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "/tmp/test.txt", content: "hello" },
          tool_use_id: "tool_" + randomUUID().slice(0, 8),
        },
      });
      // Immediately cancel it
      await new Promise((r) => setTimeout(r, 50));
      write({
        type: "control_cancel_request",
        request_id: requestId,
      });
      pendingRequests.delete(requestId);
      // Small delay then emit result
      await new Promise((r) => setTimeout(r, 50));
      emitAssistant(`[turn ${turnCount}] Cancel test completed`);
      emitResult(snippet);
      return;
    }

    // --- Default: simple response ---
    emitAssistant(`[turn ${turnCount}] Processed: ${snippet}`);
    emitResult(snippet);
    return;
  }
});

rl.on("close", () => {
  process.exit(0);
});
