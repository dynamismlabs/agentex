#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (value) => {
  if (process.env.MOCK_MCP_LOG) appendFileSync(process.env.MOCK_MCP_LOG, JSON.stringify(value) + "\n");
};
log({ args, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AGENTEX_CODEX_MCP_") || key === "CODEX_HOME")) });
if (args.includes("--version")) {
  process.stdout.write(`codex-cli ${process.env.MOCK_MCP_VERSION ?? "0.160.0"}\n`);
  process.exit(0);
}
if (args.includes("mcp") && args.includes("list")) {
  if (process.env.MOCK_MCP_FAILURE) { process.stderr.write(process.env.MOCK_MCP_FAILURE); process.exit(1); }
  const overridden = args.some((arg) => arg.startsWith("mcp_servers="));
  write(JSON.parse((overridden ? process.env.MOCK_MCP_EFFECTIVE : process.env.MOCK_MCP_AMBIENT) ?? "[]"));
  process.exit(0);
}
if (args.includes("exec")) {
  process.stdin.resume();
  process.stdin.on("end", () => {
    write({ type: "thread.started", thread_id: "mcp-execution" });
    write({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    write({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  });
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line); log({ rpc: msg });
    if (!msg.method || msg.id === undefined) return;
    write({ id: msg.id, result: msg.method.startsWith("thread/") ? { thread: { id: msg.params?.threadId ?? "mcp-session" } } : {} });
  });
}
