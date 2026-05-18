/**
 * Concurrent-send smoke test — exercises the new send-while-busy and
 * cancel(uuid) features against real Claude and Codex CLIs.
 *
 * Usage:
 *   pnpm tsx scripts/concurrent-smoke.ts                  # both providers
 *   pnpm tsx scripts/concurrent-smoke.ts claude           # claude only
 *   pnpm tsx scripts/concurrent-smoke.ts codex            # codex only
 *   pnpm tsx scripts/concurrent-smoke.ts claude --quiet   # less stdio noise
 *
 * Diagnostic features:
 *   - Prints session UUID + transcript path up front.
 *   - Tees raw stdout/stderr chunks from the CLI (skip with --quiet).
 *   - Logs every stream event (type + short content snippet).
 *   - Polls the on-disk transcript until user-message count stabilizes
 *     before asserting — covers turns that happen AFTER the first
 *     send's result resolves (queued messages processed in a follow-up
 *     turn rather than mid-turn drained).
 */
import { readFile } from "node:fs/promises";
import { getProvider } from "../src/index.js";
import type { AgentSession, StreamEvent } from "../src/index.js";

const TURN_TIMEOUT_MS = 180_000;
const POST_TURN_QUIET_MS = 15_000; // wait this long for follow-up turns
const POST_TURN_POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let QUIET = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function header(line: string): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(line);
  console.log("=".repeat(70));
}

function step(label: string): void { console.log(`\n  → ${label}`); }
function pass(label: string): void { console.log(`     PASS — ${label}`); }
function fail(issues: string[]): void { console.log(`     FAIL: ${issues.join(", ")}`); }

function nowHMS(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function logStdio(stream: "stdout" | "stderr", chunk: string): void {
  if (QUIET) return;
  // Trim trailing whitespace; print each NDJSON line on its own row so it's
  // easy to scan. Stderr never bunches into JSON — print verbatim.
  const trimmed = chunk.replace(/\s+$/, "");
  if (!trimmed) return;
  if (stream === "stderr") {
    console.log(`     [${nowHMS()} ERR] ${trimmed.replace(/\n/g, "\n         ")}`);
    return;
  }
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    // Compact the JSON for one-line display.
    let display = line;
    try {
      const parsed = JSON.parse(line);
      // Choose a discriminator: Claude uses `type`; JSON-RPC uses `method` for
      // requests/notifications, `id` (+ result/error) for responses; legacy
      // Codex NDJSON uses `type`.
      let label: string;
      if (typeof parsed.method === "string") label = `rpc:${parsed.method}`;
      else if (typeof parsed.id !== "undefined") label = `rpc-response:id=${parsed.id}`;
      else if (typeof parsed.type === "string") label = parsed.type;
      else label = "?";
      const subtype = parsed.subtype ? `/${parsed.subtype}` : "";
      const uuid = parsed.uuid ? ` uuid=${String(parsed.uuid).slice(0, 8)}` : "";
      const reqId = parsed.request_id ? ` req=${String(parsed.request_id).slice(0, 8)}` : "";

      // Build a short payload preview.
      let preview = "";
      if (parsed.message?.content) {
        const c = parsed.message.content;
        preview = typeof c === "string" ? c.slice(0, 70) : JSON.stringify(c).slice(0, 70);
      } else if (parsed.result && typeof parsed.result === "object") {
        preview = JSON.stringify(parsed.result).slice(0, 100);
      } else if (parsed.result) {
        preview = String(parsed.result).slice(0, 70);
      } else if (parsed.params && typeof parsed.params === "object") {
        preview = JSON.stringify(parsed.params).slice(0, 100);
      } else if (parsed.request?.subtype) preview = `subtype=${parsed.request.subtype}`;
      else if (parsed.response?.subtype) preview = `subtype=${parsed.response.subtype}`;
      else if (parsed.error) preview = `error=${JSON.stringify(parsed.error).slice(0, 80)}`;

      display = `${label}${subtype}${uuid}${reqId}${preview ? ` — ${preview}` : ""}`;
    } catch {
      display = line.slice(0, 140);
    }
    console.log(`     [${nowHMS()} OUT] ${display}`);
  }
}

function logEvent(e: StreamEvent): void {
  if (QUIET) return;
  const t = e.type;
  let preview = "";
  if (t === "assistant" || t === "thinking" || t === "result") preview = e.text.slice(0, 80);
  else if (t === "tool_call") preview = `${e.name}(${JSON.stringify(e.input).slice(0, 60)})`;
  else if (t === "tool_result") preview = `${e.isError ? "[ERR] " : ""}${e.content.slice(0, 80)}`;
  console.log(`     [${nowHMS()} EVT] ${t}${preview ? ` — ${preview}` : ""}`);
}

async function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS),
    ),
  ]);
}

async function checkAuth(providerType: string): Promise<boolean> {
  const provider = getProvider(providerType);
  const auth = await provider.resolveAuth();
  if (!auth.binary.installed) {
    console.log(`  SKIP — ${providerType} binary not installed`);
    return false;
  }
  const anyAuthed = auth.options.some((o) => o.present);
  if (!anyAuthed) {
    console.log(`  SKIP — ${providerType} has no present auth (run \`${providerType} login\` or set credentials)`);
    return false;
  }
  return true;
}

/**
 * Pull all human-sent message texts from a session transcript.
 *
 * Claude writes user input three different ways depending on how it arrived:
 *   1. `type: "user"` with `message.content` — direct sends that landed when
 *      the queue was idle.
 *   2. `type: "attachment"` with `attachment.type: "queued_command"` and an
 *      `attachment.prompt` string — sends that were drained mid-turn and
 *      injected as `<system-reminder>` blocks onto a tool_result. THIS is
 *      where concurrent-send messages show up after Claude's mid-turn drain.
 *   3. `type: "queue-operation", operation: "enqueue"` — an audit log of
 *      enqueue events; not load-bearing for content but useful as a sanity
 *      check that the queue saw the send at all.
 *
 * Codex writes `type: "response_item"` with `payload: {type:"message",
 * role:"user", content:[{type:"input_text", text:...}]}`.
 *
 * Returns one entry per source with a `kind` tag for diagnostics.
 */
interface TranscriptMessage {
  kind: "user" | "queued_command" | "queue_op" | "codex_user";
  text: string;
}

async function readUserMessages(filePath: string): Promise<TranscriptMessage[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;

    // Claude: direct user message
    if (o["type"] === "user" && typeof o["message"] === "object" && o["message"] !== null) {
      const msg = o["message"] as Record<string, unknown>;
      const content = msg["content"];
      if (typeof content === "string") {
        messages.push({ kind: "user", text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text") {
            const t = (block as Record<string, unknown>)["text"];
            if (typeof t === "string") messages.push({ kind: "user", text: t });
          }
        }
      }
    }

    // Claude: queued message drained mid-turn as a `queued_command` attachment
    if (o["type"] === "attachment" && typeof o["attachment"] === "object" && o["attachment"] !== null) {
      const att = o["attachment"] as Record<string, unknown>;
      if (att["type"] === "queued_command") {
        const prompt = att["prompt"];
        if (typeof prompt === "string") {
          messages.push({ kind: "queued_command", text: prompt });
        } else if (Array.isArray(prompt)) {
          for (const block of prompt) {
            if (typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text") {
              const t = (block as Record<string, unknown>)["text"];
              if (typeof t === "string") messages.push({ kind: "queued_command", text: t });
            }
          }
        }
      }
    }

    // Claude: queue-operation audit log (enqueue records carry content)
    if (o["type"] === "queue-operation" && o["operation"] === "enqueue") {
      const content = o["content"];
      if (typeof content === "string") {
        messages.push({ kind: "queue_op", text: content });
      }
    }

    // Codex: response_item envelope
    if (o["type"] === "response_item") {
      const payload = o["payload"];
      if (typeof payload === "object" && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (p["type"] === "message" && p["role"] === "user") {
          const content = p["content"];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "object" && block !== null) {
                const b = block as Record<string, unknown>;
                if (b["type"] === "input_text" && typeof b["text"] === "string") {
                  messages.push({ kind: "codex_user", text: b["text"] });
                }
              }
            }
          }
        }
      }
    }
  }
  return messages;
}

async function locateTranscript(
  providerType: string,
  sessionId: string,
  cwd: string,
): Promise<{ filePath: string } | null> {
  const provider = getProvider(providerType);
  if (!provider.transcript) return null;
  return provider.transcript.find({ sessionId, cwd });
}

/**
 * Poll the transcript until user-message count stabilizes for several
 * consecutive checks (no new turns landing), then return the final list.
 */
async function waitForTranscriptStable(
  providerType: string,
  sessionId: string,
  cwd: string,
  expectedMin: number,
): Promise<TranscriptMessage[]> {
  const startedAt = Date.now();
  let lastCount = -1;
  let stableTicks = 0;
  let final: TranscriptMessage[] = [];

  while (Date.now() - startedAt < POST_TURN_QUIET_MS) {
    const found = await locateTranscript(providerType, sessionId, cwd);
    if (!found) {
      await sleep(POST_TURN_POLL_INTERVAL_MS);
      continue;
    }
    final = await readUserMessages(found.filePath);
    if (final.length === lastCount) {
      stableTicks++;
      if (stableTicks >= 2 && final.length >= expectedMin) {
        console.log(`     transcript stable at ${final.length} entries`);
        return final;
      }
    } else {
      stableTicks = 0;
    }
    if (!QUIET && final.length !== lastCount) {
      const byKind = final.reduce<Record<string, number>>((acc, m) => {
        acc[m.kind] = (acc[m.kind] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`     [${nowHMS()}] transcript has ${final.length} entries ${JSON.stringify(byKind)} (waiting…)`);
    }
    lastCount = final.length;
    await sleep(POST_TURN_POLL_INTERVAL_MS);
  }
  console.log(`     transcript poll timed out at ${final.length} entries`);
  return final;
}

// ---------------------------------------------------------------------------
// Test: Claude concurrent send
// ---------------------------------------------------------------------------

async function testClaudeConcurrent(): Promise<boolean> {
  header("Claude — concurrent send (3 messages during sleep)");
  if (!(await checkAuth("claude"))) return true;

  const provider = getProvider("claude");
  if (!provider.createSession) return true;

  const cwd = process.cwd();
  const events: StreamEvent[] = [];

  step("opening session");
  const session: AgentSession = await provider.createSession({
    cwd,
    config: { skipPermissions: true, maxTurns: 10, timeoutSec: 120 },
    onOutput: (s, chunk) => logStdio(s, chunk),
    onEvent: (e) => { events.push(e); logEvent(e); },
  });

  const issues: string[] = [];
  try {
    step("send #1 — long-running task (run `sleep 10`)");
    console.log(`     [${nowHMS()} >>>] send #1`);
    const h1 = await session.send(
      "Run `sleep 10` via the Bash tool, then list the additional tasks you received while sleeping.",
    );
    console.log(`     uuid #1: ${h1.uuid}`);

    // Wait 4s — long enough for Claude to read the prompt and start the
    // sleep tool, so #2 and #3 land mid-turn (during the tool execution).
    await sleep(4000);
    if (session.sessionId) console.log(`     session UUID known: ${session.sessionId}`);

    step("send #2 — should hit Claude's queue mid-turn");
    console.log(`     [${nowHMS()} >>>] send #2`);
    const h2 = await session.send("ADDITIONAL TASK A: also tell me the current year.");
    console.log(`     uuid #2: ${h2.uuid}`);

    step("send #3 — should hit Claude's queue mid-turn");
    console.log(`     [${nowHMS()} >>>] send #3`);
    const h3 = await session.send("ADDITIONAL TASK B: also pick a random color and name it.");
    console.log(`     uuid #3: ${h3.uuid}`);

    step("awaiting first send's result (turn 1 finishes when sleep completes + agent responds)");
    const r1 = await withTimeout("claude r1", h1.result);
    console.log(`     [${nowHMS()}] r1 status=${r1.status}`);

    step("waiting for follow-up turns (if any) — polling transcript until stable");
    if (!session.sessionId) {
      issues.push("session.sessionId is null — can't read transcript");
    } else {
      console.log(`     session UUID: ${session.sessionId}`);
      const found = await locateTranscript("claude", session.sessionId, cwd);
      if (found) console.log(`     transcript path: ${found.filePath}`);

      // We track three places Claude can record human input: direct `user`
      // entries, mid-turn-drained `queued_command` attachments, and the
      // `queue-operation` audit log. The TASK A / TASK B messages will land
      // as `queued_command` attachments (mid-turn drain). Send #1 lands as
      // a `user` entry.
      const userMessages = await waitForTranscriptStable("claude", session.sessionId, cwd, 3);

      step("verifying transcript contains all 3 inputs");
      console.log(`     transcript entries (kind:text):`);
      for (const [i, m] of userMessages.entries()) {
        console.log(`       [${i}] ${m.kind}: ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}`);
      }
      const hasLong = userMessages.some((m) => m.text.includes("sleep 10"));
      // Prefer mid-turn-drained `queued_command` attachments as the source
      // of truth — those prove Claude actually injected the queued message
      // into the model's context. Fall back to plain user / queue_op for
      // the test to still pass under non-mid-turn-drain paths.
      const drainedA = userMessages.some(
        (m) => m.kind === "queued_command" && m.text.includes("ADDITIONAL TASK A"),
      );
      const drainedB = userMessages.some(
        (m) => m.kind === "queued_command" && m.text.includes("ADDITIONAL TASK B"),
      );
      const anyA = userMessages.some((m) => m.text.includes("ADDITIONAL TASK A"));
      const anyB = userMessages.some((m) => m.text.includes("ADDITIONAL TASK B"));

      if (!hasLong) issues.push("transcript missing the long-running prompt");
      if (!anyA) issues.push("ADDITIONAL TASK A not found anywhere in transcript");
      if (!anyB) issues.push("ADDITIONAL TASK B not found anywhere in transcript");
      if (anyA && !drainedA) {
        console.log("     note: Task A found, but not via mid-turn drain — likely processed as a follow-up turn");
      }
      if (anyB && !drainedB) {
        console.log("     note: Task B found, but not via mid-turn drain — likely processed as a follow-up turn");
      }
      if (drainedA && drainedB) {
        console.log("     ✓ both queued messages were injected via Claude's mid-turn drain (system-reminder path)");
      }
    }

    step("verifying assistant response addressed the queued tasks");
    const assistantText = events
      .filter((e): e is Extract<StreamEvent, { type: "assistant" }> => e.type === "assistant")
      .map((e) => e.text)
      .join("\n");
    const respLower = assistantText.toLowerCase();
    if (!respLower.includes("year")) {
      issues.push("assistant response doesn't mention the year (Task A reference)");
    }
    if (!respLower.includes("color")) {
      issues.push("assistant response doesn't mention a color (Task B reference)");
    }
  } finally {
    await session.close();
  }

  if (issues.length > 0) { fail(issues); return false; }
  pass("all 3 sends reached the model and got addressed");
  return true;
}

// ---------------------------------------------------------------------------
// Test: Claude cancel
// ---------------------------------------------------------------------------

async function testClaudeCancel(): Promise<boolean> {
  header("Claude — cancel queued message before mid-turn drain");
  if (!(await checkAuth("claude"))) return true;

  const provider = getProvider("claude");
  if (!provider.createSession) return true;

  const cwd = process.cwd();
  const events: StreamEvent[] = [];

  step("opening session");
  const session: AgentSession = await provider.createSession({
    cwd,
    config: { skipPermissions: true, maxTurns: 10, timeoutSec: 120 },
    onOutput: (s, chunk) => logStdio(s, chunk),
    onEvent: (e) => { events.push(e); logEvent(e); },
  });

  const issues: string[] = [];
  try {
    step("send #1 — long-running task");
    console.log(`     [${nowHMS()} >>>] send #1`);
    const h1 = await session.send(
      "Run `sleep 10` via the Bash tool, then tell me what additional tasks you received while sleeping. If none, say so plainly.",
    );

    await sleep(2000);
    if (session.sessionId) console.log(`     session UUID: ${session.sessionId}`);

    step("send #2 — to be cancelled");
    console.log(`     [${nowHMS()} >>>] send #2 (will cancel immediately)`);
    const h2 = await session.send(
      "CANCELLED TASK SENTINEL: please mention the word 'pomegranate' in your response.",
    );
    console.log(`     uuid #2: ${h2.uuid}`);

    step("cancel #2");
    console.log(`     [${nowHMS()} >>>] cancel ${h2.uuid}`);
    const cancelResult = await session.cancel(h2.uuid);
    console.log(`     [${nowHMS()}] cancel result: ${JSON.stringify(cancelResult)}`);

    step("awaiting first send's result");
    const r1 = await withTimeout("claude cancel r1", h1.result);
    console.log(`     [${nowHMS()}] r1 status=${r1.status}`);

    step("polling transcript until stable");
    if (!session.sessionId) {
      issues.push("session.sessionId is null");
    } else {
      const userMessages = await waitForTranscriptStable("claude", session.sessionId, cwd, 1);
      console.log(`     transcript entries:`);
      for (const [i, m] of userMessages.entries()) {
        console.log(`       [${i}] ${m.kind}: ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}`);
      }
      // The sentinel is "load-bearing" only if it appears in the model's
      // context — i.e., a `queued_command` attachment or a plain `user`
      // entry. Bare queue-operation enqueue logs don't count (those just
      // mean we wrote it; they don't prove the model saw it).
      const hasSentinelInContext = userMessages.some(
        (m) => (m.kind === "queued_command" || m.kind === "user") && m.text.includes("CANCELLED TASK SENTINEL"),
      );

      const assistantText = events
        .filter((e): e is Extract<StreamEvent, { type: "assistant" }> => e.type === "assistant")
        .map((e) => e.text)
        .join("\n");
      const mentionsSentinel = assistantText.toLowerCase().includes("pomegranate");

      if (cancelResult.cancelled) {
        if (hasSentinelInContext) issues.push("cancel reported success but the sentinel reached the model's context");
        if (mentionsSentinel) issues.push("cancel reported success but the assistant mentioned the sentinel");
        if (issues.length === 0) pass("cancel succeeded and the message never reached the model");
      } else {
        if (!hasSentinelInContext) issues.push("cancel reported false (raced past drain) but sentinel is missing from context");
        if (issues.length === 0) pass("cancel raced past mid-turn drain — expected race outcome");
      }
    }

    await session.close();
    if (issues.length > 0) { fail(issues); return false; }
    return true;
  } finally {
    if (session.state !== "closed") await session.close();
  }
}

// ---------------------------------------------------------------------------
// Test: Codex concurrent send
// ---------------------------------------------------------------------------

async function testCodexConcurrent(): Promise<boolean> {
  header("Codex — concurrent send (2 messages during sleep)");
  if (!(await checkAuth("codex"))) return true;

  const provider = getProvider("codex");
  if (!provider.createSession) return true;

  const cwd = process.cwd();
  const events: StreamEvent[] = [];

  step("opening session");
  const session: AgentSession = await provider.createSession({
    cwd,
    config: { skipPermissions: true, timeoutSec: 120 },
    onOutput: (s, chunk) => logStdio(s, chunk),
    onEvent: (e) => { events.push(e); logEvent(e); },
  });

  const issues: string[] = [];
  try {
    step("send #1 — long-running task");
    console.log(`     [${nowHMS()} >>>] send #1`);
    const h1 = await session.send(
      "Run the shell command `sleep 10`, then list any additional tasks you received while sleeping.",
    );

    await sleep(4000);
    if (session.sessionId) console.log(`     session UUID: ${session.sessionId}`);

    step("send #2 — queued during turn");
    console.log(`     [${nowHMS()} >>>] send #2`);
    const h2 = await session.send("ADDITIONAL TASK: tell me the current year.");
    console.log(`     uuid #2 (local): ${h2.uuid}`);

    step("awaiting first send's result");
    const r1 = await withTimeout("codex r1", h1.result);
    console.log(`     [${nowHMS()}] r1 status=${r1.status}`);

    step("polling transcript");
    if (!session.sessionId) {
      issues.push("session.sessionId is null");
    } else {
      const userMessages = await waitForTranscriptStable("codex", session.sessionId, cwd, 2);
      console.log(`     transcript entries:`);
      for (const [i, m] of userMessages.entries()) {
        console.log(`       [${i}] ${m.kind}: ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}`);
      }
      const hasLong = userMessages.some((m) => m.text.includes("sleep 10"));
      const hasA = userMessages.some((m) => m.text.includes("ADDITIONAL TASK"));
      if (!hasLong) issues.push("transcript missing the long-running prompt");
      if (!hasA) issues.push("transcript missing ADDITIONAL TASK");
    }

    step("verifying assistant response");
    const assistantText = events
      .filter((e): e is Extract<StreamEvent, { type: "assistant" }> => e.type === "assistant")
      .map((e) => e.text)
      .join("\n");
    if (!assistantText.toLowerCase().includes("year")) {
      issues.push("assistant response doesn't mention the year");
    }
  } finally {
    await session.close();
  }

  if (issues.length > 0) { fail(issues); return false; }
  pass("both sends reached the model and got addressed");
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  QUIET = argv.includes("--quiet");
  const filterArgs = argv.filter((a) => !a.startsWith("--"));
  const toTest = filterArgs.length > 0 ? filterArgs : ["claude", "codex"];

  let passed = 0;
  let failed = 0;

  if (toTest.includes("claude")) {
    try {
      if (await testClaudeConcurrent()) passed++;
      else failed++;
    } catch (err) {
      console.error("\nFATAL in claude concurrent test:", err);
      failed++;
    }
    try {
      if (await testClaudeCancel()) passed++;
      else failed++;
    } catch (err) {
      console.error("\nFATAL in claude cancel test:", err);
      failed++;
    }
  }

  if (toTest.includes("codex")) {
    try {
      if (await testCodexConcurrent()) passed++;
      else failed++;
    } catch (err) {
      console.error("\nFATAL in codex concurrent test:", err);
      failed++;
    }
  }

  header(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
