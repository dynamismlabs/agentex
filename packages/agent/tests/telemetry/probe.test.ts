import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "../../src/registry.js";
const fixture = fileURLToPath(new URL("../fixtures/mock-sessionless-telemetry.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup(protocol: "claude" | "codex", env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "agentex-probe-")); dirs.push(cwd);
  const log = join(cwd, "requests.jsonl");
  const ctx = { cwd, config: { command: fixture }, env: { MOCK_PROTOCOL: protocol, MOCK_LOG: log, ...env } };
  const logs = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const closed = async () => { for (const row of await logs()) if (row.event === "start") expect(() => process.kill(row.pid, 0)).toThrow(); };
  return { ctx, logs, closed, probe: getProvider(protocol).probeCapabilities! };
}
describe("telemetry-only runtime capability diagnostics", () => {
  it.each(["claude", "codex"] as const)("%s deduplicates probes per runtime/config/auth and retains no completed report cache", async (protocol) => {
    const f = await setup(protocol, { MOCK_DELAY: "80" });
    const [a, b] = await Promise.all([f.probe(f.ctx), f.probe({ ...f.ctx, refresh: true })]);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(a.binary.status).toBe("supported");
    expect(a.capabilities.contextUsage?.supported).toBe(true); expect(a.capabilities.rateLimits?.supported).toBe(true);
    expect(a.capabilities.sessions).toBeUndefined(); expect(a.binary.version).toBe(protocol === "claude" ? "2.1.295" : "0.160.0");
    expect((await f.logs()).filter((x) => x.event === "start" && x.mode === "control")).toHaveLength(1);
    await f.probe(f.ctx); expect((await f.logs()).filter((x) => x.event === "start" && x.mode === "control")).toHaveLength(2); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s initialization timeout degrades telemetry without disabling binary/session availability", async (protocol) => {
    const f = await setup(protocol, { MOCK_IGNORE: "initialize" });
    const [a, b] = await Promise.all([f.probe(f.ctx), f.probe(f.ctx)]);
    expect(a).toEqual(b); expect(a.binary.status).toBe("supported"); expect(a.binary.reason).toBeUndefined();
    expect(a.capabilities.sessions).toBeUndefined();
    expect(a.capabilities.rateLimits).toMatchObject({ supported: false, status: "degraded" });
    if (protocol === "codex") {
      expect(a.capabilities.mcp?.supported).toBe(true); expect(a.capabilities.strictMcpIsolation?.supported).toBe(true);
      expect(a.capabilities.contextUsage?.supported).toBe(true);
    } else expect(a.capabilities.contextUsage?.supported).toBe(false);
    expect((await f.logs()).filter((x) => x.event === "start" && x.mode === "control")).toHaveLength(1); await f.closed();
  });
  it("Codex account/read timeout leaves verified context and MCP capabilities intact", async () => {
    const f = await setup("codex", { MOCK_IGNORE: "account/read" });
    const result = await f.probe(f.ctx);
    expect(result.binary.status).toBe("supported"); expect(result.capabilities.contextUsage?.supported).toBe(true);
    expect(result.capabilities.mcp?.supported).toBe(true); expect(result.capabilities.rateLimits?.supported).toBe(false); await f.closed();
  });
  it.each(["claude", "codex"] as const)("%s unavailable quota method changes only quota capabilities", async (protocol) => {
    const f = await setup(protocol, { MOCK_ERROR: protocol === "codex" ? "account/rateLimits/read" : "get_usage" });
    const result = await f.probe(f.ctx);
    expect(result.binary.status).toBe("supported"); expect(result.capabilities.contextUsage?.supported).toBe(true);
    expect(result.capabilities.rateLimits?.supported).toBe(false); expect(result.capabilities.sessions).toBeUndefined(); await f.closed();
  });
  it("separates credential and config scopes across simultaneous probes", async () => {
    const f = await setup("claude");
    await Promise.all([f.probe(f.ctx), f.probe({ ...f.ctx, env: { ...f.ctx.env, ANTHROPIC_AUTH_TOKEN: "other" } }), f.probe({ ...f.ctx, config: { ...f.ctx.config, model: "other" } })]);
    expect((await f.logs()).filter((x) => x.event === "start" && x.mode === "control")).toHaveLength(3); await f.closed();
  });
  it("reports missing only when the selected binary cannot be found", async () => {
    const f = await setup("claude");
    expect(await f.probe({ ...f.ctx, config: { command: join(f.ctx.cwd, "missing") } })).toMatchObject({ binary: { status: "missing" }, capabilities: {} });
    expect(await f.logs()).toEqual([]);
  });
});
