import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeOpenCodeProvider } from "../../../src/providers/opencode/execute.js";
import { prepareOpenCodeMcp, supportsOpenCodeMcpIsolation } from "../../../src/providers/opencode/mcp-config.js";
import { buildEnv, ensurePathInEnv } from "../../../src/utils/env.js";

// Real-binary proof of strict MCP isolation. Opt in with AGENTEX_REAL_OPENCODE=1
// and OpenCode 2.3 or newer (AGENTEX_OPENCODE_BIN, else `opencode` on PATH).
// The runtime, model endpoint, and MCP endpoints run locally on fresh state.

function openCodeBinary(): string | null {
  const candidate = process.env.AGENTEX_OPENCODE_BIN ?? "opencode";
  try {
    const version = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return supportsOpenCodeMcpIsolation(version.match(/\d+\.\d+\.\d+/)?.[0] ?? null) ? candidate : null;
  } catch {
    return null;
  }
}

const binary = process.env.AGENTEX_REAL_OPENCODE === "1" ? openCodeBinary() : null;
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/** A minimal streamable-HTTP MCP server that records every request it gets. */
async function fakeMcp(name: string): Promise<{ url: string; requests: Array<{ rpc: string | null; auth: string | null }> }> {
  const requests: Array<{ rpc: string | null; auth: string | null }> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let message: { id?: unknown; method?: string; params?: { protocolVersion?: string } } | null = null;
    try { message = JSON.parse(body); } catch { /* GET and empty bodies */ }
    requests.push({ rpc: message?.method ?? null, auth: req.headers.authorization ?? null });
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    if (!message || message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" }, instructions: `Fixture instructions from ${name} MCP` }
      : message.method === "tools/list"
        ? { tools: [{ name: "probe", description: "Probe tool", inputSchema: { type: "object", properties: {} } }] }
        : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests };
}

describe.skipIf(!binary)("OpenCode strict MCP isolation (real OpenCode 2 binary)", () => {
  it("keeps the same host MCP surface across a config reload and a one-shot run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentex-oc-isolation-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const marker = path.join(root, "global-server-ran");
    for (const dir of ["project", "config/opencode", "data", "state", "cache", "home"]) fs.mkdirSync(path.join(root, dir), { recursive: true });

    const host = await fakeMcp("host");
    const ambient = await fakeMcp("ambient");
    const modelRequests: string[] = [];
    const model = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      modelRequests.push(body);
      const delta = (change: object, finish: string | null = null) => `data: ${JSON.stringify({
        id: "fixture", model: "model", created: 0, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: change, finish_reason: finish }],
      })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(delta({ role: "assistant", content: "Fixture reply" }) + delta({}, "stop") + "data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => model.close(() => resolve())));
    const remote = { type: "remote", url: ambient.url };
    const projectConfig = path.join(project, "opencode.json");
    const writeProject = (servers: Record<string, object>) => fs.writeFileSync(projectConfig, JSON.stringify({
      plugins: ["*"],
      mcp: { servers },
    }));
    writeProject({ ri: remote, repo: remote });
    fs.writeFileSync(path.join(root, "config/opencode/opencode.json"), JSON.stringify({
      mcp: { servers: { global: { type: "local", command: ["/bin/sh", "-c", `touch '${marker}'; sleep 30`] } } },
    }));

    const overrides = {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      PWD: root, // The CLI must use the verified folder, even with an inherited PWD.
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, apiKey: "fixture" },
        models: { model: { name: "Fixture model" } },
      } } }),
    };
    const env = buildEnv(overrides);
    ensurePathInEnv(env);
    const config = { command: binary!, mcpServers: [{ name: "ri", type: "http" as const, url: host.url, headers: { Authorization: "Bearer proof" } }] };
    const prepared = await prepareOpenCodeMcp({
      config,
      binary: { bin: binary!, prefixArgs: [] },
      env,
      cwd: project,
    });
    const server = prepared.server!;
    cleanups.push(() => server.retire({ force: true }));
    expect(server).toBeTruthy();

    const created = await server.client.request("/api/session", { method: "POST", body: "{}" });
    expect(created.ok).toBe(true);
    let statuses: Record<string, string> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await server.client.json<{ data?: Array<{ name: string; status?: { status?: string } }> }>("/api/mcp");
      statuses = Object.fromEntries((listed.data ?? []).map((entry) => [entry.name, entry.status?.status ?? ""]));
      if (statuses["ri"] === "connected") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(statuses).toEqual({ ri: "connected" });

    const empty = await prepareOpenCodeMcp({
      config: { strictMcpConfig: true }, binary: { bin: binary!, prefixArgs: [] }, env, cwd: project,
    });
    const emptyServer = empty.server!;
    cleanups.push(() => emptyServer.retire({ force: true }));
    expect(emptyServer.client.baseUrl).not.toBe(server.client.baseUrl);
    expect(await emptyServer.client.json("/api/mcp")).toMatchObject({ data: [] });

    // Force config to reload after the project file changes, even with the private watcher off.
    writeProject({ ri: remote, repo: remote, late: remote });
    await server.client.ok("/api/experimental/config", { method: "PATCH", body: JSON.stringify({ shell: null }) });
    await expect.poll(async () => JSON.stringify(await server.client.json("/api/config"))).toContain('"late"');

    const result = await executeOpenCodeProvider({
      cwd: project, env: overrides, model: "fixture/model", prompt: "Reply once",
      config: { ...config, timeoutSec: 12, unattendedPermissionPolicy: "deny" },
    });
    expect(result).toMatchObject({ status: "completed", summary: "Fixture reply" });
    const run = await server.client.json(`/api/session/${result.sessionDisplayId}`);
    expect(run).toMatchObject({ data: { id: result.sessionDisplayId, location: { directory: fs.realpathSync(project) } } });
    expect(modelRequests.some((body) => body.includes("Fixture instructions from host MCP"))).toBe(true);
    const listed = await server.client.json<{ data: Array<{ name: string }> }>("/api/mcp");
    expect(listed.data.map((entry) => entry.name)).toEqual(["ri"]);
    expect(host.requests.filter((request) => request.rpc === "initialize")).toHaveLength(1);
    const resumed = await executeOpenCodeProvider({
      cwd: project, env: overrides, model: "fixture/model", prompt: "Reply again",
      config: { ...config, timeoutSec: 12, unattendedPermissionPolicy: "deny" },
      sessionParams: result.sessionParams,
    });
    expect(resumed).toMatchObject({ status: "completed", sessionDisplayId: result.sessionDisplayId });
    expect(host.requests.some((request) => request.rpc === "tools/list" && request.auth === "Bearer proof")).toBe(true);
    expect(ambient.requests).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
