#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const protocol = process.env.MOCK_PROTOCOL;
const args = process.argv.slice(2);
const mode = args.includes("--version") ? "version" : args.includes("generate-ts") ? "schema" : "control";
const log = (value) => { if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, JSON.stringify(value) + "\n"); };
log({ event: "start", mode, pid: process.pid, args });
if (protocol === "antigravity") {
  log({ event: "agy", mode, cwd: process.cwd(), autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null });
  if (mode === "version") {
    console.log(process.env.MOCK_AGY_VERSION ?? "1.1.11");
    process.exit(0);
  }
  const expected = ["--settings", '{"disableSlashCommands":false}', "--print", "/usage", "--output-format", "json"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) { log({ event: "unexpected", args }); process.exit(9); }
  if (process.env.MOCK_AGY_SIGNED_OUT) {
    console.error("Authentication required: Bearer raw-secret-token");
    process.exit(1);
  }
  if (process.env.MOCK_AGY_EXIT) {
    console.error("flag provided but not defined: -settings");
    process.exit(Number(process.env.MOCK_AGY_EXIT));
  }
  if (process.env.MOCK_AGY_CHILD) {
    // Like an MCP server agy starts and leaves running: same process group, no stdin.
    const stderr = process.env.MOCK_AGY_CHILD === "stderr" ? 2 : "ignore";
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["ignore", "ignore", stderr] });
    child.unref();
    log({ event: "child", pid: child.pid });
  }
  log({ event: "request", method: "usage", cwd: process.cwd() });
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_DELAY ?? 0)));
  // Shaped like agy 1.5.11 output. remaining_fraction is omitempty, so the
  // used-up pool has none, and the text report still prints its percentage.
  console.log(process.env.MOCK_RATES ?? JSON.stringify({
    conversation_id: "", status: "SUCCESS", num_turns: 0,
    response: "Gemini Models\tFive Hour Limit Remaining\t100%\t2030-01-01T00:00:00Z\n"
      + "Gemini Models\tWeekly Limit Remaining\t20%\t2030-01-01T00:00:00Z\n"
      + "Claude and GPT models\tWeekly Limit Remaining\t0%\t2030-01-01T00:00:00Z\n",
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [
        { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2030-01-01T00:00:00Z" },
        { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.2 },
        { id: "disabled", disabled: true, remaining_fraction: 1 },
        { id: "absolute", remaining_amount: 50 },
        { id: "invalid", remaining_fraction: 2 },
      ] },
      { name: "Claude and GPT models", buckets: [
        { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", reset_time: "2030-01-01T00:00:00Z" },
      ] },
    ] } },
  }));
  process.exit(0);
}
if (mode === "version") {
  console.log(protocol === "codex" ? "codex-cli 0.160.0" : "2.1.295 (Claude Code)"); process.exit(0);
}
if (mode === "schema") {
  const out = args[args.indexOf("--out") + 1]; mkdirSync(join(out, "v2"), { recursive: true });
  writeFileSync(join(out, "v2", "ThreadTokenUsage.ts"), "type ThreadTokenUsage = { last: TokenUsageBreakdown; modelContextWindow: number | null };");
  process.exit(0);
}
if (process.env.MOCK_IGNORE_TERM) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const method = protocol === "codex" ? msg.method : msg.request?.subtype;
  if (!method) { log({ event: "unexpected", msg }); return; }
  log({ event: "request", method, params: protocol === "codex" ? msg.params : msg.request });
  if (method === process.env.MOCK_IGNORE) return;
  if (method === process.env.MOCK_EXIT) { process.exit(0); }
  const reply = (result) => {
    if (method === process.env.MOCK_CLOSE_STDIN) { process.stdin.pause(); closeSync(0); setTimeout(() => process.exit(0), 5000); }
    if (protocol === "codex") write({ id: msg.id, result });
    else write({ type: "control_response", response: { request_id: msg.request_id, subtype: "success", response: result } });
  };
  if (method === process.env.MOCK_ERROR) {
    const error = process.env.MOCK_ERROR_TEXT ?? "Unknown request";
    if (protocol === "codex") write({ id: msg.id, error: { code: process.env.MOCK_ERROR_TEXT ? -32000 : -32601, message: error } });
    else write({ type: "control_response", response: { request_id: msg.request_id, subtype: "error", error } });
  } else if (method === "initialize") reply({});
  else if (method === "account/read") reply({ account: { type: process.env.MOCK_AUTH_TYPE ?? (process.env.MOCK_API_KEY ? "apiKey" : "chatgpt") } });
  else if (method === "get_context_usage") reply({ totalTokens: 70, rawMaxTokens: 100, percentage: 70, model: "future-model" });
  else if (["get_usage", "account/rateLimits/read"].includes(method)) {
    const rates = process.env.MOCK_RATES ? JSON.parse(process.env.MOCK_RATES) : protocol === "codex"
      ? { accountId: "account-a", rateLimitsByLimitId: {
        shared: { limitId: "shared", primary: { usedPercent: 0, windowDurationMins: 17, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 57, windowDurationMins: 10800 } },
        future_pool: { limitId: "future_pool", primary: { usedPercent: 8, windowDurationMins: 83 } },
      } }
      : { rate_limits_available: !process.env.MOCK_API_KEY, rate_limits: process.env.MOCK_API_KEY ? null : {
        five_hour: { utilization: 0, resets_at: "2030-01-01T00:00:00Z" }, seven_day_sonnet: { utilization: 57 }, future_pool: { utilization: 8 },
      } };
    setTimeout(() => reply(rates), Number(process.env.MOCK_DELAY ?? 30));
  } else reply({});
});
