/**
 * Phase 1 of the durable-session demo — the "host" that CRASHES mid-turn.
 *
 * Runs a real Claude session against a mock CLI, writes each streamed event's
 * raw wire line to an on-disk transcript (standing in for what the real CLI
 * persists), records `session.describe()`, then hard-exits BEFORE the turn's
 * `result` arrives — simulating a host process dying mid-turn. Spawned as a
 * child by `durable-session-demo.ts`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getProvider } from "../../src/index.js";
import type { AgentSession } from "../../src/index.js";

const home = process.env.CLAUDE_CONFIG_DIR!;
const cwd = process.env.DEMO_WORK!;
const recordPath = process.env.DEMO_RECORD_PATH!;
const mock = process.env.DEMO_MOCK!;

let transcriptPath: string | null = null;
function ensureTranscript(sid: string): void {
  if (transcriptPath) return;
  const dir = path.join(home, "projects", "demo-project");
  mkdirSync(dir, { recursive: true });
  transcriptPath = path.join(dir, `${sid}.jsonl`);
}

let session: AgentSession | null = null;

session = await getProvider("claude").createSession!({
  config: { command: mock, skipPermissions: true, timeoutSec: 30 },
  cwd,
  env: { CLAUDE_CONFIG_DIR: home },
  onEvent: (event) => {
    // Persist the raw wire line exactly as a crashing CLI would have left it.
    if (event.sessionId) ensureTranscript(event.sessionId);
    if (transcriptPath) appendFileSync(transcriptPath, JSON.stringify(event.raw) + "\n");

    if (event.type === "assistant") {
      // Mid-turn: capture the durable identity, then hard-crash before `result`.
      const rec = session?.describe?.() ?? null;
      if (rec) writeFileSync(recordPath, JSON.stringify(rec));
      console.log("  [phase 1] persisted transcript + record; crashing mid-turn (exit 1)");
      process.exit(1);
    }
  },
});

// Fire a turn; the crash happens inside onEvent when the assistant chunk lands.
void session.send("first process: begin a turn");

setTimeout(() => {
  console.error("  [phase 1] timed out without an assistant event");
  process.exit(2);
}, 15_000);
