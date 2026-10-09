import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexSession } from "../../src/providers/codex/session.js";
import { createClaudeSession } from "../../src/providers/claude/session.js";
import { acpProvider } from "../../src/providers/acp/index.js";
import type { AgentSession, StreamEvent } from "../../src/types.js";
const fixture = fileURLToPath(new URL("../fixtures/mock-telemetry-harness.mjs", import.meta.url));
const sessions: AgentSession[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((s) => s.close())); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function logFile() { const dir = await mkdtemp(join(tmpdir(), "agentex-telemetry-test-")); dirs.push(dir); return join(dir, "requests"); }
async function make(protocol: "codex" | "claude", env: Record<string, string> = {}, onEvent?: (event: StreamEvent) => void) {
  const create = protocol === "codex" ? createCodexSession : createClaudeSession;
  const session = await create({ config: { command: fixture, skipPermissions: true }, env: { ...env, MOCK_TELEMETRY_PROTOCOL: protocol }, onEvent }); sessions.push(session); return session;
}

describe("native telemetry on the session transport", () => {
  it.each([
    ["codex", "rateLimits"], ["claude", "rateLimits"], ["claude", "contextUsage"],
  ])("%s %s refresh survives stdin closing before process exit", async (protocol, surface) => {
    const marker = await logFile();
    const script = fileURLToPath(new URL("../fixtures/telemetry-closed-stdin-smoke.mjs", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, protocol!, surface!, marker], { timeout: 10_000 });
    expect(stdout.trim()).toBe("closed-stdin refresh survived");
    expect(stderr).toBe("");
  });
  it.each(["codex", "claude"] as const)("%s caches without requests and deduplicates concurrent explicit reads", async (protocol) => {
    const log = await logFile(); const session = await make(protocol, { MOCK_TELEMETRY_LOG: log });
    const before = await readFile(log, "utf8").catch(() => "");
    expect(session.contextUsage?.getSnapshot().value).toBeNull(); expect(session.rateLimits?.getSnapshot().value).toBeNull();
    expect(session.rateLimits?.getSnapshot().refreshSupported).toBe(false);
    expect(await readFile(log, "utf8").catch(() => "")).toBe(before);
    const first = session.rateLimits!.refresh!(), second = session.rateLimits!.refresh!(); expect(first).toBe(second);
    const result = await first; expect(result.support).toBe("supported"); expect(result.refreshSupported).toBe(true); expect(result.value?.buckets).toHaveLength(3);
    const calls = (await readFile(log, "utf8")).split("\n"); expect(calls.filter((x) => x === (protocol === "codex" ? "account/rateLimits/read" : "get_usage"))).toHaveLength(1);
    await session.close(); const closed = await session.rateLimits!.refresh!(); expect(closed.refreshSupported).toBe(false);
    expect(await readFile(log, "utf8")).toBe(calls.join("\n"));
  });
  it("Claude explicit session reads emit authoritative replacement updates", async () => {
    const events: StreamEvent[] = []; const session = await make("claude", {}, (event) => { events.push(event); });
    await session.rateLimits!.refresh!();
    expect(events.filter((event) => event.type === "rate_limits")).toEqual([
      expect.objectContaining({ update: expect.objectContaining({ mode: "replace" }) }),
    ]);
  });
  it("Codex observes root context without a subscriber; compaction replaces it and partial limits retain other pools", async () => {
    const session = await make("codex"); await session.rateLimits!.refresh!();
    const first = await session.send("first"); await first.result;
    expect(session.contextUsage!.getSnapshot()).toMatchObject({ support: "supported", value: { usedTokens: 70, capacityTokens: 100 } });
    const next = await session.send("compact"); await next.result;
    expect(session.contextUsage!.getSnapshot().value).toMatchObject({ usedTokens: 3, capacityTokens: 200 });
    expect(session.rateLimits!.getSnapshot().value?.buckets.map((b) => b.id)).toEqual(["common:primary", "common:secondary", "future:primary"]);
    expect(session.rateLimits!.getSnapshot().value?.buckets[0]?.usedPercent).toBe(33);
  });
  it("Claude refreshes native effective context after observed compaction and keeps legacy stream events", async () => {
    const events: StreamEvent[] = []; const session = await make("claude", {}, (event) => { events.push(event); });
    expect((await session.contextUsage!.refresh!()).value).toMatchObject({ usedTokens: 70, capacityTokens: 100 });
    await (await session.send("first")).result; await (await session.send("compact")).result;
    await session.contextUsage!.refresh!();
    await vi.waitFor(() => {
      expect(session.contextUsage!.getSnapshot().value).toMatchObject({ usedTokens: 3, capacityTokens: 200, model: "new-model" });
    }, { timeout: 2000 });
    expect(events.some((e) => e.type === "rate_limit")).toBe(true); expect(events.some((e) => e.type === "rate_limits")).toBe(true);
    expect(events.some((e) => e.type === "context_usage_invalidated")).toBe(true);
  });
  it("does not mark an initial Claude read fresh when compaction crossed it", async () => {
    const session = await make("claude", { MOCK_CONTEXT_DELAY_MS: "80" });
    await (await session.send("first")).result;
    const pending = session.contextUsage!.refresh!();
    await (await session.send("compact")).result;
    expect((await pending).status).not.toBe("fresh");
    await vi.waitFor(() => {
      expect(session.contextUsage!.getSnapshot()).toMatchObject({ status: "fresh", value: { usedTokens: 3, capacityTokens: 200 } });
    }, { timeout: 2000 });
  });
  it.each(["codex", "claude"] as const)("%s gates unsupported runtime/auth instead of inferring available quota", async (protocol) => {
    const unsupported = await make(protocol, { MOCK_TELEMETRY_UNSUPPORTED: "1" }); expect((await unsupported.rateLimits!.refresh!()).status).toBe("unsupported");
    const api = await make(protocol, { MOCK_API_KEY: "1" }); expect((await api.rateLimits!.refresh!()).status).toBe("unsupported");
  });
  it("keeps simultaneous accounts and endpoints isolated", async () => {
    const a = await make("codex", { MOCK_ACCOUNT: "a" }); const b = await make("codex", { MOCK_ACCOUNT: "b" });
    const [ar, br] = await Promise.all([a.rateLimits!.refresh!(), b.rateLimits!.refresh!()]);
    expect(ar.value?.accountId).toBe("a"); expect(br.value?.accountId).toBe("b"); expect(ar.value?.authContextId).not.toBe(br.value?.authContextId);
  });
  it.each(["codex", "claude"] as const)("%s discards a read that crossed an auth change", async (protocol) => {
    const session = await make(protocol, { MOCK_AUTH_CHANGE: "1" });
    const crossed = await session.rateLimits!.refresh!();
    expect(crossed.value).toBeNull();
    expect(crossed.support).toBe("unknown");
    const current = await session.rateLimits!.refresh!();
    expect(current.support).toBe("supported");
    if (protocol === "codex") expect(current.value?.accountId).toBe("new-account");
  });
  it.each(["codex", "claude"] as const)("%s settles pending telemetry when the session closes", async (protocol) => {
    const session = await make(protocol);
    const pending = session.rateLimits!.refresh!();
    await session.close();
    const result = await pending;
    expect(result.refreshSupported).toBe(false);
    expect(result.value).toBeNull();
  });
});

describe("ACP standard reaches the client through the SDK", () => {
  it.each(["exit", "error"] as const)("marks observed context stale on unexpected process %s", async (failure) => {
    const command = [process.execPath, fileURLToPath(new URL("../fixtures/mock-acp-agent.mjs", import.meta.url))];
    const provider = acpProvider({ id: "future-acp", command, env: { MOCK_ACP_CONTEXT: "1" } });
    const session = await provider.createSession!({}); sessions.push(session);
    await vi.waitFor(() => expect(session.contextUsage!.getSnapshot().status).toBe("fresh"));
    const before = session.contextUsage!.getSnapshot({ maxAgeMs: Infinity });
    const proc = (session as unknown as { proc: ChildProcess }).proc;
    if (failure === "exit") proc.kill("SIGKILL");
    else proc.emit("error", new Error("simulated process failure"));
    await vi.waitFor(() => expect(session.state).toBe("closed"));
    expect(session.contextUsage!.getSnapshot({ maxAgeMs: Infinity })).toMatchObject({
      support: "supported", status: "stale", value: before.value,
      refreshSupported: false, reason: "Session transport is closed",
    });
  });
  it("receives idle usage_update, then compaction updates, without synthesizing turn accounting", async () => {
    const command = [process.execPath, fileURLToPath(new URL("../fixtures/mock-acp-agent.mjs", import.meta.url))];
    const provider = acpProvider({ id: "future-acp", command, env: { MOCK_ACP_CONTEXT: "1" } });
    const session = await provider.createSession!({}); sessions.push(session);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.contextUsage!.getSnapshot().value).toMatchObject({ usedTokens: 12, capacityTokens: 100, sessionCost: { amount: 3, currency: "USD" } });
    const turn = await (await session.send("compact")).result;
    expect(turn.usage).toBeUndefined(); expect(turn.costUsd).toBeNull();
    expect(session.contextUsage!.getSnapshot().value).toMatchObject({ usedTokens: 3, capacityTokens: 200 });
    expect(session.rateLimits!.getSnapshot().status).toBe("unsupported"); expect(session.contextUsage!.refresh).toBeUndefined();
  });
});
