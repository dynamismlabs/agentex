// Mock `codex app-server` for spawn tests. Writes one argv element per line to
// MOCK_DUMP_ARGS_TO, appends every request it receives as a JSON line to
// MOCK_DUMP_REQUESTS_TO, and answers the handshake: `initialize`,
// `thread/start` (thread "mock-thread") and `thread/resume` (the id it was given).
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argsFile = process.env.MOCK_DUMP_ARGS_TO;
if (argsFile) writeFileSync(argsFile, process.argv.slice(2).map((arg) => `${arg}\n`).join(""));

const requestsFile = process.env.MOCK_DUMP_REQUESTS_TO;

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (typeof msg.method !== "string" || msg.id === undefined) return;
  if (requestsFile) appendFileSync(requestsFile, `${JSON.stringify(msg)}\n`);
  if (msg.method === "thread/start") reply(msg.id, { thread: { id: "mock-thread" } });
  else if (msg.method === "thread/resume") reply(msg.id, { thread: { id: msg.params?.threadId } });
  else reply(msg.id, {});
});
