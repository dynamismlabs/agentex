/** Opt-in, non-inference verification against a real Codex 0.160+ binary.
 * Only local test MCP tools are called. No Ri server or connected account is used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexSession } from "../src/providers/codex/session.js";
import type { CodexSessionImpl } from "../src/providers/codex/session.js";

const dir = await realpath(await mkdtemp(join(tmpdir(), "agentex-live-codex-mcp-")));
const oldCwd = join(dir, "original-project");
await mkdir(oldCwd);
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const configBefore = await readFile(join(codexHome, "config.toml")).catch(() => null);
let httpCalls = 0;
const http = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  assert.equal(req.headers.authorization, "Bearer local-test-token");
  assert.equal(req.headers["x-session-credential"], "local-test-credential");
  let body = ""; for await (const chunk of req) body += chunk;
  const msg = JSON.parse(body);
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  const result = msg.method === "initialize" ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-http", version: "1" } }
    : msg.method === "tools/list" ? { tools: [{ name: "echo", description: "Read-only local test", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }
    : msg.method === "tools/call" ? (httpCalls++, { content: [{ type: "text", text: "http-ok" }] }) : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address(); assert.ok(address && typeof address !== "string");
const servers = [
  { name: "agentex_http_smoke", type: "http" as const, url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer local-test-token", "X-Session-Credential": "local-test-credential" } },
  { name: "agentex_stdio_smoke", command: process.execPath, args: [fileURLToPath(new URL("../tests/fixtures/mock-codex-mcp-server.mjs", import.meta.url))], env: { AGENTEX_MCP_TEST_VALUE: "stdio-ok" } },
];
let session: Awaited<ReturnType<typeof createCodexSession>> | undefined;
let threadId: string | null = null;
const createdThreads = new Set<string>();
const rpc = (session: unknown) => (session as { boundedRpcRequest(method: string, params: Record<string, unknown>, timeout?: number): Promise<Record<string, unknown>> }).boundedRpcRequest.bind(session);
try {
  // Persist a thread created without host servers. Injecting local history
  // items is a native non-inference operation; an entirely empty thread is not
  // durably resumable after its app-server exits.
  session = await createCodexSession({ cwd: oldCwd, config: { strictMcpConfig: true } });
  threadId = session.sessionId;
  assert.ok(threadId); createdThreads.add(threadId);
  await rpc(session)("thread/inject_items", { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Local MCP smoke history marker. No inference requested." }] }] });
  await session.close(); session = undefined;
  for (const resume of [false, true]) {
    session = await createCodexSession({ cwd: dir, config: { mcpServers: servers }, ...(resume ? { sessionParams: { sessionId: threadId } } : {}) });
    assert.ok(session.sessionId); createdThreads.add(session.sessionId);
    if (resume) assert.equal(session.sessionId, threadId);
    const request = rpc(session as CodexSessionImpl);
    const current = await request("thread/read", { threadId: session.sessionId });
    assert.equal((current.thread as { cwd: string }).cwd, dir);
    const inventory = await request("mcpServerStatus/list", { threadId: session.sessionId, limit: 100 }, 20_000);
    const rows = inventory.data as { name: string; runtimeStatus: string | null; tools: Record<string, unknown> }[];
    const configured = rows.filter((row) => row.name !== "codex_apps" && row.runtimeStatus !== "disabled").map((row) => row.name).sort();
    assert.deepEqual(configured, servers.map((server) => server.name).sort());
    for (const row of rows.filter((row) => row.runtimeStatus === "disabled")) assert.equal(Object.keys(row.tools).length, 0);
    let stdioPid: number | undefined;
    for (const server of servers) {
      const result = await request("mcpServer/tool/call", { threadId: session.sessionId, server: server.name, tool: "echo", arguments: {} }, 20_000);
      assert.ok(JSON.stringify(result).includes(server.type === "http" ? "http-ok" : "stdio-ok"));
      if (server.type !== "http") stdioPid = (result.structuredContent as { pid: number }).pid;
    }
    // Archive only the local test thread we created, leaving user history alone.
    await request("thread/archive", { threadId: session.sessionId });
    createdThreads.delete(session.sessionId);
    await session.close(); session = undefined;
    assert.ok(stdioPid);
    assert.throws(() => process.kill(stdioPid, 0), { code: "ESRCH" });
    console.log(`${resume ? "resumed" : "new"} thread: HTTP headers, stdio env and strict configured-MCP isolation verified`);
  }
  assert.equal(httpCalls, 2);
  assert.deepEqual(await readFile(join(codexHome, "config.toml")).catch(() => null), configBefore);
  console.log("User config unchanged; no inference prompt or connected-account tool was used");
} finally {
  if (session) for (const id of createdThreads) await rpc(session)("thread/archive", { threadId: id }, 5000).catch(() => {});
  await session?.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
