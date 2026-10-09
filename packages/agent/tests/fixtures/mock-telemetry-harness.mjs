#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, closeSync, writeFileSync } from "node:fs";
const protocol = process.env.MOCK_TELEMETRY_PROTOCOL;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0;
let authChanged = false;
if (process.env.MOCK_TELEMETRY_PID_FILE) writeFileSync(process.env.MOCK_TELEMETRY_PID_FILE, String(process.pid));
const rates = () => ({ accountId: authChanged ? "new-account" : process.env.MOCK_ACCOUNT ?? "account-a", ordinaryUsageAllowed: false, rateLimitsByLimitId: {
  common: { limitId: "common", primary: { usedPercent: 32, windowDurationMins: 17, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 57, windowDurationMins: 10800, resetsAt: 2_000_000_100 } },
  future: { limitId: "future", primary: { usedPercent: 8, windowDurationMins: 83, resetsAt: 2_000_000_200 } },
} });
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const method = protocol === "codex" ? msg.method : msg.request?.subtype;
  if (method) {
    if (process.env.MOCK_TELEMETRY_LOG) appendFileSync(process.env.MOCK_TELEMETRY_LOG, method + "\n");
    if (method === process.env.MOCK_IGNORE_METHOD) return;
    if (process.env.MOCK_AUTH_CHANGE && !authChanged && ["get_usage", "account/rateLimits/read"].includes(method)) {
      setTimeout(() => {
        authChanged = true;
        if (protocol === "codex") write({ method: "account/updated", params: { authMode: "chatgpt" } });
        else write({ type: "auth_status", isAuthenticating: false, output: [] });
      }, 10);
    }
    const reply = (result) => {
      if (protocol === "codex") write({ id: msg.id, result });
      else write({ type: "control_response", response: { request_id: msg.request_id, subtype: "success", response: result } });
      if (method === process.env.MOCK_CLOSE_STDIN_AFTER_METHOD) {
        // Keep the process alive after closing the OS pipe, reproducing the
        // interval where a host write gets EPIPE before it observes child exit.
        process.stdin.pause();
        closeSync(0);
        writeFileSync(process.env.MOCK_STDIN_CLOSED_FILE, "closed");
        setTimeout(() => process.exit(0), 5000);
      }
    };
    if (process.env.MOCK_TELEMETRY_UNSUPPORTED && ["get_context_usage", "get_usage", "account/rateLimits/read"].includes(method)) {
      if (protocol === "codex") write({ id: msg.id, error: { code: -32601, message: "Method not found" } });
      else write({ type: "control_response", response: { request_id: msg.request_id, subtype: "error", error: "Unknown request" } });
    } else if (method === "initialize") reply({ userAgent: "codex-cli/0.160.0" });
    else if (method === "get_binary_version") reply({ version: "2.1.295" });
    else if (method === "account/read") reply({ account: { type: process.env.MOCK_API_KEY ? "apiKey" : "chatgpt" } });
    else if (method === "account/rateLimits/read") setTimeout(() => reply(rates()), 30);
    else if (method === "get_usage") setTimeout(() => reply({ rate_limits_available: !process.env.MOCK_API_KEY, rate_limits: process.env.MOCK_API_KEY ? null : { five_hour: { utilization: 32, resets_at: "2030-01-01T00:00:00Z" }, seven_day_sonnet: { utilization: 8 }, new_pool: { utilization: 4 } } }), 30);
    else if (method === "get_context_usage") {
      const observation = { totalTokens: turn > 1 ? 3 : 70, rawMaxTokens: turn > 1 ? 200 : 100, percentage: turn > 1 ? 1.5 : 70, model: turn > 1 ? "new-model" : "old-model" };
      setTimeout(() => reply(observation), Number(process.env.MOCK_CONTEXT_DELAY_MS ?? "0"));
    }
    else if (method === "thread/start" || method === "thread/resume") reply({ thread: { id: "mock-root" }, model: "old-model" });
    else if (method === "turn/start") {
      turn++; reply({ turn: { id: `turn-${turn}` } });
      write({ method: "thread/tokenUsage/updated", params: { threadId: "foreign-child", tokenUsage: { last: { totalTokens: 99 }, modelContextWindow: 100 } } });
      write({ method: "thread/tokenUsage/updated", params: { threadId: "mock-root", tokenUsage: { total: { totalTokens: 9000 }, last: { totalTokens: turn > 1 ? 3 : 70 }, modelContextWindow: turn > 1 ? 200 : 100 } } });
      write({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "common", primary: { usedPercent: 33, windowDurationMins: 17 } } } });
      write({ method: "turn/completed", params: { threadId: "mock-root", turn: { id: `turn-${turn}`, status: "completed", usage: { inputTokens: 5, outputTokens: 2 } } } });
    } else reply({});
    return;
  }
  if (protocol === "claude" && msg.type === "user") {
    turn++;
    write({ type: "system", subtype: "init", session_id: "claude-root", model: turn > 1 ? "new-model" : "old-model" });
    if (turn > 1) write({ type: "system", subtype: "compact_boundary", session_id: "claude-root" });
    write({ type: "rate_limit_event", session_id: "claude-root", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.33, unifiedWindows: { five_hour: { utilization: 0.33 }, seven_day: { utilization: 0.5 } } } });
    write({ type: "assistant", session_id: "claude-root", message: { content: [{ type: "text", text: "done" }] } });
    write({ type: "result", subtype: "success", session_id: "claude-root", result: "done", usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0, is_error: false });
  }
});
