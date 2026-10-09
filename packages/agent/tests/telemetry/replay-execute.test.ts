import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexProvider } from "../../src/providers/codex/index.js";
import { claudeProvider } from "../../src/providers/claude/index.js";
import { createSessionRecord } from "../../src/sessions/index.js";
import { readLatestCodexTelemetry } from "../../src/telemetry/codex-durable.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { executeCodexProvider } from "../../src/providers/codex/execute.js";
import { executeClaudeProvider } from "../../src/providers/claude/execute.js";
const dirs: string[] = [];
const time = "2026-07-02T12:00:00.000Z";
const later = "2026-07-02T12:00:01.000Z";
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function home() { const dir = await mkdtemp(join(tmpdir(), "agentex-telemetry-replay-")); dirs.push(dir); return dir; }
async function rollout(root: string, id: string) {
  const dir = join(root, "sessions", "2026", "07", "02");
  await mkdir(dir, { recursive: true });
  const lines = [
    { timestamp: time, type: "session_meta", payload: { id, cwd: "/repo" } },
    { timestamp: time, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 9999 }, last_token_usage: { total_tokens: 40 }, model_context_window: 200 }, rate_limits: { limit_id: "first", primary: { used_percent: 10, window_minutes: 71 } } } },
    { timestamp: time, type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } },
    { timestamp: later, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "second", primary: { used_percent: 90 } } } },
  ];
  await writeFile(join(dir, `rollout-2026-07-02T12-00-00-${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

describe("durable telemetry and one-shot accounting", () => {
  it("restores independent Codex observations even when the last row contains only another pool", async () => {
    const root = await home(); const id = "22222222-2222-2222-2222-222222222222";
    await rollout(root, id);
    const store = new TelemetryStore();
    for (const event of await readLatestCodexTelemetry(id, { CODEX_HOME: root })) store.observe(event);
    expect(store.context.getSnapshot()).toMatchObject({ status: "stale", value: { usedTokens: 40, capacityTokens: 200, observedAt: time } });
    expect(store.rateLimits.getSnapshot().value?.buckets.map((bucket) => bucket.id)).toEqual(["first:primary", "second:primary"]);
    expect(await readLatestCodexTelemetry("foreign-session", { CODEX_HOME: root })).toEqual([]);
    const attachment = await codexProvider.attachSession!(createSessionRecord({ providerType: "codex", params: { sessionId: id, cwd: "/repo" } }), { env: { CODEX_HOME: root } });
    expect(attachment.lastTurn).toBe("completed");
    expect(attachment.contextUsage!.getSnapshot().value?.usedTokens).toBe(40);
    expect(attachment.rateLimits!.refresh).toBeUndefined();
    const events = []; for await (const { event } of attachment.catchUp()) events.push(event.type);
    expect(events).toEqual(["context_usage", "rate_limits", "result", "rate_limits"]);
  });
  it("replays Claude native context and family buckets at their source time", async () => {
    const root = await home(); const id = "11111111-1111-1111-1111-111111111111";
    const dir = join(root, "projects", "-work"); await mkdir(dir, { recursive: true });
    const lines = [
      { type: "system", subtype: "init", session_id: id, cwd: "/work", timestamp: time },
      { type: "result", subtype: "success", session_id: id, timestamp: time, result: "done", context_usage: { total_tokens: 20, raw_max_tokens: 100, percentage: 20, model: "native" } },
      { type: "rate_limit_event", timestamp: later, session_id: id, rate_limit_info: { status: "allowed", rateLimitType: "seven_day_sonnet", utilization: 0.2 } },
    ];
    await writeFile(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const attachment = await claudeProvider.attachSession!(createSessionRecord({ providerType: "claude", params: { sessionId: id, cwd: "/work" } }), { env: { CLAUDE_CONFIG_DIR: root } });
    expect(attachment.lastTurn).toBe("completed");
    expect(attachment.contextUsage!.getSnapshot()).toMatchObject({ status: "stale", value: { usedTokens: 20, observedAt: time } });
    expect(attachment.rateLimits!.getSnapshot().value?.buckets[0]).toMatchObject({ id: "seven_day_sonnet", applicability: { kind: "model_family", family: "sonnet" }, observedAt: later });
  });
  it("hydrates Codex execute from its exact native transcript without treating billed usage as context", async () => {
    const root = await home(); await rollout(root, "codex-thread-1");
    const command = fileURLToPath(new URL("../fixtures/mock-codex.sh", import.meta.url));
    const result = await executeCodexProvider({ prompt: "test", config: { command }, env: { CODEX_HOME: root, MOCK_BEHAVIOR: "success" } });
    expect(result.contextUsage?.value).toMatchObject({ usedTokens: 40, capacityTokens: 200 });
    expect(result.rateLimitSnapshot).toMatchObject({ status: "unobserved", value: null });
  });
  it("does not substitute Claude one-shot accounting when no context/capacity source exists", async () => {
    const command = fileURLToPath(new URL("../fixtures/mock-claude.sh", import.meta.url));
    const result = await executeClaudeProvider({ prompt: "test", config: { command }, env: { MOCK_BEHAVIOR: "success", MOCK_FORMAT: "claude" } });
    expect(result.costUsd).toBe(0.0025);
    expect(result.contextUsage).toMatchObject({ support: "unknown", status: "unobserved", value: null });
    expect(result.rateLimitSnapshot).toMatchObject({ support: "unknown", status: "unobserved", value: null });
  });
});
