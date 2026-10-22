// Mock `codex app-server` for spawn tests. Writes one argv element per line to
// MOCK_DUMP_ARGS_TO, appends every request it receives as a JSON line to
// MOCK_DUMP_REQUESTS_TO, and answers the handshake: `initialize`,
// `thread/start` (thread "mock-thread") and `thread/resume` (the id it was given).
// `turn/start` runs a turn that answers "echo: <text>".
// MOCK_DUMP_SKILL_ROOTS_TO: on `skills/extraRoots/set`, appends what each root
//   holds (JSON): every skill folder in it, its link target, and its SKILL.md.
// MOCK_CODEX_NO_EXTRA_ROOTS=1: reject `skills/extraRoots/set` as an unknown
//   method, like a codex-cli that predates it.
// MOCK_CODEX_FAIL_METHOD=<method>: answer that method with an error (only the
//   first time with MOCK_CODEX_FAIL_ONCE=1).
// MOCK_CODEX_HANG_METHOD=<method>: never answer that method, like a stalled app-server.
// MOCK_PID_FILE: write this process's pid.
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argsFile = process.env.MOCK_DUMP_ARGS_TO;
if (argsFile) writeFileSync(argsFile, process.argv.slice(2).map((arg) => `${arg}\n`).join(""));

const requestsFile = process.env.MOCK_DUMP_REQUESTS_TO;
if (process.env.MOCK_PID_FILE) writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
let failed = false;
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
let threadId = "mock-thread";
let turns = 0;

const describeRoot = (root) => ({
  root,
  skills: existsSync(root)
    ? readdirSync(root).sort().map((name) => {
        const entry = `${root}/${name}`;
        let skill = null;
        try { skill = readFileSync(`${entry}/SKILL.md`, "utf8"); } catch { /* unreadable */ }
        return { name, link: lstatSync(entry).isSymbolicLink() ? readlinkSync(entry) : null, skill };
      })
    : null,
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (typeof msg.method !== "string" || msg.id === undefined) return;
  if (requestsFile) appendFileSync(requestsFile, `${JSON.stringify(msg)}\n`);
  if (msg.method === process.env.MOCK_CODEX_HANG_METHOD) return;
  if (msg.method === process.env.MOCK_CODEX_FAIL_METHOD && !(failed && process.env.MOCK_CODEX_FAIL_ONCE === "1")) {
    failed = true;
    return fail(msg.id, -32000, `mock failure: ${msg.method}`);
  }
  if (msg.method === "skills/extraRoots/set") {
    if (process.env.MOCK_CODEX_NO_EXTRA_ROOTS === "1") return fail(msg.id, -32601, "Method not found: skills/extraRoots/set");
    if (process.env.MOCK_DUMP_SKILL_ROOTS_TO) {
      appendFileSync(process.env.MOCK_DUMP_SKILL_ROOTS_TO, `${JSON.stringify((msg.params?.extraRoots ?? []).map(describeRoot))}\n`);
    }
    return reply(msg.id, {});
  }
  if (msg.method === "thread/start") return reply(msg.id, { thread: { id: threadId } });
  if (msg.method === "thread/resume") {
    threadId = msg.params?.threadId;
    return reply(msg.id, { thread: { id: threadId } });
  }
  if (msg.method === "turn/start") {
    const turnId = `mock-turn-${++turns}`;
    const text = (msg.params?.input ?? []).map((part) => part.text ?? "").join("");
    reply(msg.id, { turn: { id: turnId } });
    write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `${turnId}-message`, text: `echo: ${text}`, phase: "final_answer" } } });
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  reply(msg.id, {});
});
