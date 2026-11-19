import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareOpenCodeMcp } from "../../../src/providers/opencode/mcp-config.js";
import { buildEnv, ensurePathInEnv } from "../../../src/utils/env.js";

// Real-binary proof of strict MCP isolation. Opt in with AGENTEX_REAL_OPENCODE=1
// and an OpenCode 2 binary (AGENTEX_OPENCODE_BIN, else `opencode` on PATH; the
// opencode-ai dev dependency is OpenCode 1). No model is needed: OpenCode
// connects MCP servers when a session is created, so creating one and reading
// GET /api/mcp shows exactly which servers it reached. Every OpenCode folder
// (config, data, state, cache) is a fresh temp folder.

function openCodeBinary(): string | null {
  const candidate = process.env.AGENTEX_OPENCODE_BIN ?? "opencode";
  try {
    const version = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const major = Number(version.match(/(\d+)\.\d+\.\d+/)?.[1] ?? 0);
    return major >= 2 ? candidate : null;
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
      ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } }
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
  it("connects the host server and never reaches a project or global one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentex-oc-isolation-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const marker = path.join(root, "global-server-ran");
    for (const dir of ["project", "config/opencode", "data", "state", "cache"]) fs.mkdirSync(path.join(root, dir), { recursive: true });

    const host = await fakeMcp("host");
    const ambient = await fakeMcp("ambient");
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ mcp: { servers: { repo: { type: "remote", url: ambient.url } } } }));
    fs.writeFileSync(path.join(root, "config/opencode/opencode.json"), JSON.stringify({
      mcp: { servers: { global: { type: "local", command: ["/bin/sh", "-c", `touch '${marker}'; sleep 30`] } } },
    }));

    const env = buildEnv({
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    });
    ensurePathInEnv(env);
    const prepared = await prepareOpenCodeMcp({
      config: { mcpServers: [{ name: "ri", type: "http", url: host.url, headers: { Authorization: "Bearer proof" } }] },
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

    expect(statuses).toEqual({ ri: "connected", repo: "disabled", global: "disabled" });
    expect(host.requests.some((request) => request.rpc === "tools/list" && request.auth === "Bearer proof")).toBe(true);
    expect(ambient.requests).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
