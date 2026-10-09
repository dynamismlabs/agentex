#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const protocol = process.env.MOCK_PROTOCOL;
const args = process.argv.slice(2);
const mode = args.includes("--version") ? "version" : args.includes("generate-ts") ? "schema" : "control";
const log = (value) => { if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, JSON.stringify(value) + "\n"); };
log({ event: "start", mode, pid: process.pid, args });
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
