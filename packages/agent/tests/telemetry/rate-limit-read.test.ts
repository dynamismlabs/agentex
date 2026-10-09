import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "../../src/registry.js";
import { acpProvider } from "../../src/providers/acp/index.js";
import { httpAgentProvider } from "../../src/providers/_shared/http-agent.js";
import type { RateLimitReadContext } from "../../src/types.js";

const fixture = fileURLToPath(new URL("../fixtures/mock-sessionless-telemetry.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup(protocol: "claude" | "codex", env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "agentex-rate-read-")); dirs.push(cwd);
  const log = join(cwd, "requests.jsonl");
  const ctx: RateLimitReadContext = { cwd, config: { command: fixture }, env: { MOCK_PROTOCOL: protocol, MOCK_LOG: log, ...env } };
  const read = (changes: Partial<RateLimitReadContext> = {}) => getProvider(protocol).readRateLimits!({ ...ctx, ...changes });
  const logs = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const closed = async () => { for (const row of await logs()) if (row.event === "start") expect(() => process.kill(row.pid, 0)).toThrow(); };
  return { cwd, ctx, read, logs, closed };
}

describe("explicit sessionless account reads", () => {
  it.each(["claude", "codex"] as const)("%s emits an authoritative observation without a probe, prompt, or conversation", async (protocol) => {
    const f = await setup(protocol);
    const result = await f.read();
    expect(result).toMatchObject({ support: "supported", status: "fresh", refreshSupported: true, value: { mode: "replace", snapshot: { provider: protocol } } });
    const snapshot = result.value!.snapshot;
    expect(snapshot.buckets).toHaveLength(3); expect(snapshot.buckets[0]?.usedPercent).toBe(0);
    expect(Number.isFinite(Date.parse(snapshot.observedAt))).toBe(true);
    expect(snapshot.buckets.every((b) => b.observedAt === snapshot.observedAt && !b.stale)).toBe(true);
    const logs = await f.logs();
    expect(logs.filter((x) => x.event === "start")).toHaveLength(1);
    expect(logs.filter((x) => x.event === "request").map((x) => x.method)).toEqual(protocol === "codex"
      ? ["initialize", "account/read", "account/rateLimits/read"] : ["initialize", "get_usage"]);
    expect(logs.some((x) => x.event === "unexpected")).toBe(false);
    if (protocol === "claude") {
      expect(logs[0].args).toEqual(expect.arrayContaining(["--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", '{"mcpServers":{}}']));
      expect(logs.find((x) => x.method === "get_usage").params.skip_behaviors).toBe(true);
      expect(snapshot.buckets.find((b) => b.id === "seven_day_sonnet")?.applicability).toEqual({ kind: "model_family", family: "sonnet" });
    } else {
      expect(snapshot.buckets[0]?.durationMs).toBe(17 * 60_000);
      expect(logs.find((x) => x.method === "account/read").params).toEqual({ refreshToken: false });
    }
    await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s shares matching in-flight work but not completed data or mutable results", async (protocol) => {
    const f = await setup(protocol, { MOCK_DELAY: "100" });
    const [a, b] = await Promise.all([f.read(), f.read({ env: Object.fromEntries(Object.entries(f.ctx.env!).reverse()) })]);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(a.value).not.toBe(b.value);
    a.value!.snapshot.buckets[0]!.usedPercent = 999; expect(b.value!.snapshot.buckets[0]?.usedPercent).toBe(0);
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(1);
    const c = await f.read(); expect(c.value?.snapshot.authContextId).not.toBe(b.value?.snapshot.authContextId);
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(2); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s isolates config, cwd and credential environment", async (protocol) => {
    const f = await setup(protocol, { MOCK_DELAY: "100" });
    const other = join(f.cwd, "other"); await mkdir(other);
    await Promise.all([f.read(), f.read({ cwd: other }), f.read({ config: { ...f.ctx.config, model: "other" } }),
      f.read({ env: { ...f.ctx.env, ANTHROPIC_AUTH_TOKEN: "secret-never-logged" } })]);
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(4); await f.closed();
  });
  it("scopes in-flight reads by native auth file revision without reading credentials", async () => {
    const f = await setup("codex", { MOCK_DELAY: "200" });
    const home = join(f.cwd, "codex-home"); await mkdir(home);
    f.ctx.env!.CODEX_HOME = home; await writeFile(join(home, "auth.json"), "opaque-a");
    const first = f.read(); await vi.waitFor(async () => expect((await f.logs()).some((x) => x.method === "account/rateLimits/read")).toBe(true));
    await writeFile(join(home, "auth.json"), "opaque-b-new-size");
    await Promise.all([first, f.read()]);
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(2); await f.closed();
  });
  it("separates an upgraded runtime at the same command path from an in-flight read", async () => {
    const f = await setup("claude", { MOCK_DELAY: "200" });
    const command = join(f.cwd, "harness.mjs"); await copyFile(fixture, command); await chmod(command, 0o755);
    f.ctx.config!.command = command;
    const first = f.read(); await vi.waitFor(async () => expect((await f.logs()).some((x) => x.method === "get_usage")).toBe(true));
    await writeFile(command, (await readFile(command, "utf8")) + "\n// runtime upgrade\n");
    await Promise.all([first, f.read()]);
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(2); await f.closed();
  });
  it("aborting the last caller closes the process before returning", async () => {
    const f = await setup("claude", { MOCK_IGNORE: "get_usage" }); const controller = new AbortController();
    const pending = f.read({ signal: controller.signal });
    await vi.waitFor(async () => expect((await f.logs()).some((x) => x.method === "get_usage")).toBe(true));
    controller.abort(); expect(await pending).toMatchObject({ status: "unavailable", reason: expect.stringContaining("cancelled") }); await f.closed();
  });
  it("failed reads release their scope and missing binaries remain unavailable", async () => {
    const f = await setup("codex", { MOCK_ERROR: "account/rateLimits/read" });
    expect((await f.read()).status).toBe("unsupported"); expect((await f.read()).status).toBe("unsupported");
    expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(2);
    expect(await f.read({ config: { command: join(f.cwd, "missing") } })).toMatchObject({ status: "unavailable", value: null }); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s keeps cancellation and deadlines independent between callers", async (protocol) => {
    const f = await setup(protocol, { MOCK_DELAY: "250" });
    const controller = new AbortController();
    const cancelled = f.read({ signal: controller.signal }); const timedOut = f.read({ timeoutMs: 50 }); const surviving = f.read({ timeoutMs: 2000 });
    await vi.waitFor(async () => expect((await f.logs()).some((x) => x.event === "request")).toBe(true)); controller.abort();
    const [a, b, c] = await Promise.all([cancelled, timedOut, surviving]);
    expect(a).toMatchObject({ status: "unavailable", value: null, reason: expect.stringContaining("cancelled") });
    expect(b).toMatchObject({ status: "unavailable", value: null, reason: expect.stringContaining("timed out") });
    expect(c.status).toBe("fresh"); expect((await f.logs()).filter((x) => x.event === "start")).toHaveLength(1); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s last-caller timeout closes a stalled process before returning, then allows retry", async (protocol) => {
    const f = await setup(protocol, { MOCK_IGNORE: "initialize" });
    expect((await f.read({ timeoutMs: 100 })).status).toBe("unavailable"); await f.closed();
    const result = await f.read({ env: { ...f.ctx.env, MOCK_IGNORE: "" } }); expect(result.status).toBe("fresh"); await f.closed();
  });
  it("closes a process that ignores SIGTERM using bounded SIGKILL cleanup", async () => {
    const f = await setup("claude", { MOCK_IGNORE: "initialize", MOCK_IGNORE_TERM: "1" });
    const started = Date.now(); expect((await f.read({ timeoutMs: 150 })).status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2500); await f.closed();
  });
  it("does not spawn for pre-aborted or custom-endpoint reads, or unsupported providers", async () => {
    const f = await setup("claude"); const controller = new AbortController(); controller.abort();
    expect((await f.read({ signal: controller.signal })).status).toBe("unavailable");
    expect((await f.read({ config: { ...f.ctx.config, endpoint: { baseUrl: "http://127.0.0.1:1234", apiKey: "secret" } } })).status).toBe("unsupported");
    expect(await f.logs()).toEqual([]);
    for (const type of ["cursor", "opencode", "antigravity", "pi", "process", "openclaw", "gemini", "copilot"]) expect(getProvider(type).readRateLimits).toBeUndefined();
    expect(acpProvider.readRateLimits).toBeUndefined(); expect(httpAgentProvider.readRateLimits).toBeUndefined();
  });
  it.each(["claude", "codex"] as const)("%s reports non-service auth as unsupported", async (protocol) => {
    const f = await setup(protocol, { MOCK_API_KEY: "1" });
    expect(await f.read()).toMatchObject({ support: "unsupported", status: "unsupported", value: null, refreshSupported: false });
    if (protocol === "codex") expect((await f.logs()).some((x) => x.method === "account/rateLimits/read")).toBe(false); await f.closed();
  });
  it.each(["bedrock", "chatgptAuthTokens-unknown", "future_auth"])("Codex does not claim ChatGPT allowance for %s auth", async (type) => {
    const f = await setup("codex", { MOCK_AUTH_TYPE: type });
    expect((await f.read()).status).toBe("unsupported");
    expect((await f.logs()).some((x) => x.method === "account/rateLimits/read")).toBe(false); await f.closed();
  });
  it("preserves explicitly established support when Claude returns no metrics", async () => {
    const f = await setup("claude", { MOCK_RATES: '{"rate_limits_available":true,"rate_limits":null}' });
    expect(await f.read()).toMatchObject({ support: "supported", status: "unavailable", refreshSupported: true, value: null }); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s returns safe failures for unavailable methods, native errors, and closed stdin", async (protocol) => {
    const method = protocol === "claude" ? "get_usage" : "account/rateLimits/read";
    for (const env of [{ MOCK_ERROR: method }, { MOCK_ERROR: method, MOCK_ERROR_TEXT: "Bearer raw-secret-token" }, { MOCK_CLOSE_STDIN: "initialize" }, { MOCK_EXIT: "initialize" }]) {
      const f = await setup(protocol, env); const result = await f.read();
      expect(["unsupported", "unavailable"]).toContain(result.status); expect(result.value).toBeNull();
      expect(JSON.stringify(result)).not.toContain("raw-secret-token"); await f.closed();
    }
  });
  it.each(["claude", "codex"] as const)("%s distinguishes explicit empty, malformed, and expired observations", async (protocol) => {
    const empty = protocol === "codex" ? { rateLimitsByLimitId: {} } : { rate_limits_available: true, rate_limits: {} };
    const f = await setup(protocol, { MOCK_RATES: JSON.stringify(empty) });
    expect(await f.read()).toMatchObject({ status: "fresh", value: { mode: "replace", snapshot: { buckets: [] } } });
    expect(await f.read({ env: { ...f.ctx.env, MOCK_RATES: '{}' } })).toMatchObject({ status: "unavailable", value: null });
    const expired = protocol === "codex" ? { rateLimitsByLimitId: { past: { limitId: "past", primary: { usedPercent: 80, resetsAt: 1 } } } }
      : { rate_limits: { past: { utilization: 80, resets_at: "2000-01-01T00:00:00Z", token: "secret", future_detail: "retained" } } };
    const result = await f.read({ env: { ...f.ctx.env, MOCK_RATES: JSON.stringify(expired) } });
    expect(result).toMatchObject({ status: "stale", value: { snapshot: { buckets: [{ usedPercent: 80, stale: true }] } } });
    expect(JSON.stringify(result)).not.toContain("secret"); if (protocol === "claude") expect(JSON.stringify(result)).toContain("retained"); await f.closed();
  });
  it("rejects invalid timeout values before spawning", async () => {
    const f = await setup("claude");
    for (const timeoutMs of [0, -1, NaN, Infinity]) await expect(f.read({ timeoutMs })).rejects.toThrow("positive finite");
    expect(await f.logs()).toEqual([]);
  });
});
