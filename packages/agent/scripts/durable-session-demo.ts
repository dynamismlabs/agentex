/**
 * End-to-end proof of the durable-sessions headline (spec §8).
 *
 *   Phase 1 — a child "host" process starts a real Claude session (against a
 *             mock CLI), persists a SessionRecord, and CRASHES mid-turn.
 *   Phase 2 — a fresh process reads the record and:
 *               • attachSession()  → reports lastTurn: "interrupted"
 *               • catchUp()        → replays the events the first process saw
 *               • resume()         → continues the session live
 *
 * Run:  pnpm -C packages/agent exec tsx scripts/durable-session-demo.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "../src/index.js";
import { assertSessionRecord } from "../src/sessions/index.js";
import type { CatchUpYield, SessionRecord, TurnResult } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(here, "..", "tests", "fixtures", "mock-claude-session.sh");
const HOST = path.join(here, "lib", "durable-demo-host.ts");

const problems: string[] = [];
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) problems.push(label);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentex-durable-home-"));
  const work = await mkdtemp(path.join(os.tmpdir(), "agentex-durable-work-"));
  const recordPath = path.join(home, "record.json");
  await mkdir(path.join(home, "projects"), { recursive: true });

  try {
    // ---- Phase 1: run a session in a child process that crashes mid-turn ----
    console.log("Phase 1 — start a session, crash mid-turn (separate process):");
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", HOST], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: home,
          DEMO_WORK: work,
          DEMO_RECORD_PATH: recordPath,
          DEMO_MOCK: MOCK,
        },
        stdio: "inherit",
      });
      child.on("exit", (code) => resolve(code ?? 0));
    });
    check("phase-1 host crashed (non-zero exit)", exitCode !== 0);
    check("phase-1 persisted a SessionRecord", await waitFor(() => exists(recordPath)));

    // ---- Phase 2: fresh attach in THIS process ----
    console.log("\nPhase 2 — reattach from the persisted record:");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as SessionRecord;
    assertSessionRecord(record);
    check("record is a valid SessionRecord", record.providerType === "claude");

    const provider = getProvider("claude");
    const att = await provider.attachSession!(record, { env: { CLAUDE_CONFIG_DIR: home } });

    check("located the on-disk transcript", att.transcript !== null);
    check(`lastTurn is "interrupted" (was ${JSON.stringify(att.lastTurn)})`, att.lastTurn === "interrupted");

    const replayed: CatchUpYield[] = [];
    for await (const y of att.catchUp()) replayed.push(y);
    console.log(`  · catchUp replayed ${replayed.length} event(s): ${replayed.map((r) => r.event.type).join(", ")}`);
    check("catchUp replayed the events the first process saw", replayed.length >= 1);
    let monotonic = true;
    for (let i = 1; i < replayed.length; i++) {
      if (replayed[i]!.offset <= replayed[i - 1]!.offset) monotonic = false;
    }
    check("catchUp offsets are monotonically increasing", monotonic);

    // resume(): continue the session live (fresh mock completes the turn).
    const resumed = await att.resume({
      config: { command: MOCK, skipPermissions: true, timeoutSec: 30 },
      cwd: work,
      env: { CLAUDE_CONFIG_DIR: home },
    });
    const handle = await resumed.send("second process: continue the session");
    const turn: TurnResult = await handle.result;
    check("resume() produced a live session that completed a turn", turn.status === "completed");
    console.log(`  · resumed turn summary: ${JSON.stringify(turn.summary)}`);
    await resumed.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }

  console.log(
    `\n${problems.length === 0 ? "PASS — durable session survived a mid-turn crash" : `FAIL — ${problems.length} check(s) failed`}`,
  );
  if (problems.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
