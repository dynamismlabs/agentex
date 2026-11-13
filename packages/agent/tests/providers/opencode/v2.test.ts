import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionRecord } from "../../../src/sessions/record.js";
import { clearModelCache } from "../../../src/utils/model-cache.js";
import { acquireOpenCodeServer } from "../../../src/providers/opencode/server.js";
import { OpenCodeClient } from "../../../src/providers/opencode/client.js";
import { probeOpenCodeCapabilities } from "../../../src/providers/opencode/probe.js";
import { listOpenCodeModels, openCodeV2ModelsFromPayload } from "../../../src/providers/opencode/discovery.js";
import { listOpenCodeModes } from "../../../src/providers/opencode/modes.js";
import { openCodeUpstreamProviders } from "../../../src/providers/opencode/manager.js";
import { collectHistory, attachOpenCodeHistory } from "../../../src/providers/opencode/history.js";
import { discoverOpenCodeSavedSessions, openCodeSavedHistory, readOpenCodeSavedSession } from "../../../src/providers/opencode/saved-history.js";
import { createOpenCodeSession } from "../../../src/providers/opencode/http-session.js";
import { terminalOutcome } from "../../../src/providers/opencode/event-parse.js";
import { parseOpenCodeJsonl, parseOpenCodeStreamLine } from "../../../src/providers/opencode/parse.js";
import { executeOpenCodeProvider } from "../../../src/providers/opencode/execute.js";
import { normalizeV2MessageToEnvelope, parseMajorVersion } from "../../../src/providers/opencode/v2.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix = "agentex-oc-v2-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  return filePath;
}

afterEach(async () => {
  clearModelCache();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCode v2 helpers & binary discovery", () => {
  it("parses v1 and v2 CLI version outputs", () => {
    expect(parseMajorVersion("2.3.0")).toBe(2);
    expect(parseMajorVersion("opencode v2.1.4")).toBe(2);
    expect(parseMajorVersion("1.3.2")).toBe(1);
    expect(parseMajorVersion("unknown")).toBeNull();
  });

  it("discovers opencode installed at ~/.opencode/bin/opencode even when absent from PATH", async () => {
    const home = makeTempDir("oc-home-");
    const binPath = writeExecutable(path.join(home, ".opencode", "bin", "opencode"), "#!/bin/sh\necho 2.3.0\n");
    const prevHome = process.env["HOME"];
    const prevPath = process.env["PATH"];
    process.env["HOME"] = home;
    process.env["PATH"] = "/nonexistent-dir";
    vi.resetModules();
    try {
      const { findBinary: findBinaryFresh } = await import("../../../src/utils/binary.js");
      const resolved = await findBinaryFresh("opencode");
      expect(resolved.bin).toBe(binPath);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      process.env["PATH"] = prevPath;
      vi.resetModules();
    }
  });
});

async function startFakeOpenCodeV2Server(options: {
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyText: string,
    emitSse: (event: Record<string, unknown>) => void,
  ) => void | Promise<void>;
}) {
  const sseClients = new Set<http.ServerResponse>();
  const emitSse = (event: Record<string, unknown>) => {
    const line = `event: server\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(line);
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/event")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (url === "/api/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "2.3.0", pid: process.pid }));
      return;
    }
    if (url === "/global/health" || url === "/doc") {
      // Simulate OpenCode v2 SPA HTML fallback on legacy v1 paths!
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html></html>");
      return;
    }

    await options.handle(req, res, bodyText, emitSse);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const c of sseClients) c.end();
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return { baseUrl, emitSse };
}

function createFakeV2Script(baseUrl: string, version = "2.3.0"): string {
  const dir = makeTempDir("oc-v2-bin-");
  return writeExecutable(
    path.join(dir, "opencode"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("${version}");
  process.exit(0);
}
if (args[0] === "serve") {
  console.log("opencode server listening on ${baseUrl}");
  setInterval(() => {}, 10000);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
`,
  );
}

describe("OpenCode v2 server, probe, discovery & modes", () => {
  it("detects v2 server on /api/info even when /global/health returns SPA HTML", async () => {
    const { baseUrl } = await startFakeOpenCodeV2Server({
      handle: (_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      },
    });
    const bin = createFakeV2Script(baseUrl);
    const cwd = makeTempDir("oc-cwd-");
    const server = await acquireOpenCodeServer(bin, [], process.env, cwd);
    cleanups.push(async () => {
      server.release();
      await server.retireAuthStore({ force: true });
    });

    expect(server.apiVersion).toBe(2);
    expect(server.serverVersion).toBe("2.3.0");
  });

  it("probes v2 capabilities, models, and modes", async () => {
    const { baseUrl } = await startFakeOpenCodeV2Server({
      handle: (req, res) => {
        if (req.url === "/openapi.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            paths: {
              "/api/session": { get: {}, post: {} },
              "/api/session/{sessionID}": { get: {} },
              "/api/session/{sessionID}/prompt": { post: {} },
              "/api/session/{sessionID}/message": { get: {} },
              "/api/session/{sessionID}/model": { post: {} },
              "/api/session/{sessionID}/agent": { post: {} },
              "/api/session/{sessionID}/permission": { get: {} },
              "/api/session/{sessionID}/permission/{requestID}/reply": { post: {} },
              "/api/session/{sessionID}/form": { get: {} },
              "/api/session/{sessionID}/form/{formID}/reply": { post: {} },
              "/api/model": { get: {} },
              "/api/credential/{credentialID}": { delete: {} },
            },
          }));
          return;
        }
        if (req.url === "/api/agent") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [
              { id: "build", name: "Build", description: "Default agent", mode: "primary", hidden: false },
              { id: "plan", name: "Plan", description: "Read-only planner", mode: "primary", hidden: false },
              { id: "general", name: "General", mode: "subagent", hidden: false },
              { id: "title", name: "Title", mode: "primary", hidden: true },
            ],
          }));
          return;
        }
        if (req.url === "/api/provider") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [{ id: "anthropic", integrationID: "anthropic", name: "Anthropic", activation: "enabled" }],
          }));
          return;
        }
        if (req.url === "/api/model") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [
              {
                id: "claude-sonnet-4-5",
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                type: "chat",
                name: "Claude Sonnet 4.5",
                capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                variants: [{ id: "low" }, { id: "high" }],
                cost: [{ input: 3, output: 15 }],
                limit: { context: 200000, output: 64000 },
              },
              {
                id: "img-gen-1",
                providerID: "anthropic",
                type: "image",
                name: "Image Gen",
              },
            ],
          }));
          return;
        }
        res.writeHead(404).end();
      },
    });

    const bin = createFakeV2Script(baseUrl);
    const cwd = makeTempDir("oc-cwd-");
    const ctx = { cwd, config: { command: bin } };

    const report = await probeOpenCodeCapabilities(ctx);
    expect(report.binary.status).toBe("supported");
    expect(report.binary.protocolProfile).toBe("opencode-server-auth-v2");
    expect(report.binary.version).toBe("2.3.0");
    expect(report.capabilities.sessions?.supported).toBe(true);
    expect(report.capabilities.upstreamProviderDisconnect?.supported).toBe(true);
    expect(report.capabilities.savedHistory?.supported).toBe(true);
    expect(report.capabilities.planMode?.supported).toBe(true);
    expect(report.capabilities.modes?.supported).toBe(true);

    const models = await listOpenCodeModels(ctx);
    expect(models).toEqual([
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        providerName: "Anthropic",
        variants: [
          { id: "low", name: "low" },
          { id: "high", name: "high" },
        ],
        contextWindow: 200000,
        maxOutputTokens: 64000,
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        supportsImages: true,
        supportsTools: true,
      },
    ]);

    const modes = await listOpenCodeModes(ctx);
    expect(modes).toEqual([
      { id: "build", name: "Build", description: "Default agent" },
      { id: "plan", name: "Plan", description: "Read-only planner" },
    ]);
  });

  it("parses direct v2 model payloads accurately", () => {
    const parsed = openCodeV2ModelsFromPayload(
      { data: [{ modelID: "gpt-5", providerID: "openai", name: "GPT-5", capabilities: { tools: false, input: ["text"] }, variants: [], cost: [] }] },
      { data: [{ id: "openai", name: "OpenAI" }] },
    );
    expect(parsed).toEqual([
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        providerName: "OpenAI",
        supportsImages: false,
        supportsTools: false,
      },
    ]);
  });
});

describe("OpenCode v2 upstream providers", () => {
  it("supports listing, key connect, code/auto OAuth, and credential disconnect", async () => {
    const deletedCreds: string[] = [];
    const connectedKeys: unknown[] = [];
    let attemptStatus = "pending";

    const { baseUrl } = await startFakeOpenCodeV2Server({
      handle: (req, res, bodyText) => {
        const url = req.url ?? "/";
        if (url === "/openapi.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ paths: { "/api/credential/{credentialID}": { delete: {} } } }));
          return;
        }
        if (url === "/api/provider") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [{ id: "anthropic", integrationID: "anthropic", name: "Anthropic", activation: "enabled" }],
          }));
          return;
        }
        if (url === "/api/provider/anthropic") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { id: "anthropic", integrationID: "anthropic" } }));
          return;
        }
        if (url === "/api/integration") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [
              {
                id: "anthropic",
                name: "Anthropic",
                methods: [
                  { type: "key", label: "API Key" },
                  { id: "claude-max", type: "oauth", label: "Claude Pro/Max" },
                  { type: "env", names: ["ANTHROPIC_API_KEY"] },
                ],
                connections: [{ type: "credential", id: "cred_1", label: "Default", method: "key" }],
              },
            ],
          }));
          return;
        }
        if (url === "/api/integration/anthropic") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: {
              id: "anthropic",
              name: "Anthropic",
              methods: [
                { type: "key", label: "API Key" },
                { id: "claude-max", type: "oauth", label: "Claude Pro/Max" },
                { type: "env", names: ["ANTHROPIC_API_KEY"] },
              ],
              connections: [{ type: "credential", id: "cred_1", label: "Default", method: "key" }],
            },
          }));
          return;
        }
        if (url === "/api/credential") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        if (url === "/api/integration/anthropic/connect/key" && req.method === "POST") {
          connectedKeys.push(JSON.parse(bodyText));
          res.writeHead(204).end();
          return;
        }
        if (url === "/api/integration/anthropic/connect/oauth" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: {
              attemptID: "att_123",
              url: "https://auth.example/oauth",
              instructions: "Complete in browser",
              mode: "auto",
            },
          }));
          return;
        }
        if (url === "/api/integration/anthropic/connect/oauth/att_123" && req.method === "GET") {
          const current = attemptStatus;
          attemptStatus = "complete";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { status: current, time: { created: 1, expires: 2 } } }));
          return;
        }
        if (url === "/api/credential/cred_1" && req.method === "DELETE") {
          deletedCreds.push("cred_1");
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end();
      },
    });

    const bin = createFakeV2Script(baseUrl);
    const cwd = makeTempDir("oc-cwd-");
    const ctx = { cwd, config: { command: bin } };

    const providers = await openCodeUpstreamProviders.list(ctx);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.connected).toBe(true);
    expect(providers[0]!.authMethodIds).toHaveLength(2);

    const methods = await openCodeUpstreamProviders.authMethods("anthropic", ctx);
    expect(methods.map((m) => m.type)).toEqual(["api_key", "oauth"]);

    await openCodeUpstreamProviders.setApiKey("anthropic", "sk-test", ctx);
    expect(connectedKeys).toEqual([{ key: "sk-test" }]);

    const flow = await openCodeUpstreamProviders.beginOAuth("anthropic", methods[1]!.id, undefined, ctx);
    expect(flow.completion).toBe("automatic");
    expect(flow.url).toBe("https://auth.example/oauth");
    await openCodeUpstreamProviders.completeOAuth(flow.id, undefined, ctx);

    await expect(openCodeUpstreamProviders.canDisconnect("anthropic", ctx)).resolves.toBe(true);
    await openCodeUpstreamProviders.disconnect("anthropic", ctx);
    expect(deletedCreds).toEqual(["cred_1"]);
  });
});

describe("OpenCode v2 history & saved-history", () => {
  it("normalizes v2 messages with deterministic part ids and tool results", () => {
    const userEnv = normalizeV2MessageToEnvelope({
      id: "msg_u1",
      type: "user",
      time: { created: 1000 },
      text: "Hello",
    });
    expect(userEnv).toEqual({
      info: { id: "msg_u1", role: "user", time: { created: 1000 } },
      parts: [{ id: "msg_u1:part:0", type: "text", text: "Hello" }],
    });

    const assistantEnv = normalizeV2MessageToEnvelope({
      id: "msg_a1",
      type: "assistant",
      agent: "build",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      time: { created: 1001, completed: 1002 },
      finish: "stop",
      cost: 0.01,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 0 } },
      content: [
        { type: "reasoning", text: "Thinking..." },
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: "/tmp" }] },
        },
        { type: "text", text: "All done." },
      ],
    });
    expect(assistantEnv?.parts[0]).toEqual({ id: "msg_a1:part:0", type: "reasoning", text: "Thinking..." });
    expect(assistantEnv?.parts[1]).toEqual({
      type: "tool",
      id: "call_1",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" }, output: "/tmp" },
    });
    expect(assistantEnv?.parts[2]).toEqual({ id: "msg_a1:part:2", type: "text", text: "All done." });

    expect(normalizeV2MessageToEnvelope({ id: "msg_meta", type: "agent-switched" })).toBeNull();
    expect(terminalOutcome({ error: { type: "interrupted", message: "Stopped" } }, false).status).toBe("aborted");
  });

  it("paginates v2 durable and saved history", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        seenUrls.push(input);
        const url = new URL(input);
        if (url.pathname === "/api/session") {
          return Response.json({
            data: [
              {
                id: "ses_1",
                title: "Refactor",
                time: { created: 1000, updated: 2000 },
                location: { directory: "/repo/app" },
              },
            ],
            cursor: { next: null, previous: null },
          });
        }
        if (url.pathname === "/api/session/ses_1/message") {
          const order = url.searchParams.get("order");
          const cursor = url.searchParams.get("cursor");
          if (url.searchParams.get("type") === "user") {
            return Response.json({
              data: [{ id: "m1", type: "user", time: { created: 1000 }, text: "First prompt" }],
              cursor: { next: null, previous: null },
            });
          }
          if (order === "desc" && !cursor) {
            return Response.json({
              data: [
                { id: "m3", type: "idle", time: { created: 1003 } },
                {
                  id: "m2",
                  type: "assistant",
                  agent: "build",
                  model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
                  time: { created: 1002 },
                  finish: "stop",
                  content: [{ type: "text", text: "Reply text" }],
                },
              ],
              cursor: { next: "page2", previous: null },
            });
          }
          if (cursor === "page2") {
            return Response.json({
              data: [{ id: "m1", type: "user", time: { created: 1000 }, text: "First prompt" }],
              cursor: { next: null, previous: null },
            });
          }
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const client = new OpenCodeClient("http://127.0.0.1:9999", "pw");
    const sessions = [];
    for await (const session of discoverOpenCodeSavedSessions(client, { includeArchived: true }, 2)) {
      sessions.push(session);
    }
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe("/repo/app");
    // Must omit `archived=true` when includeArchived is true (since archived=true filters ONLY archived in v2).
    expect(seenUrls.some((u) => u.includes("/api/session?") && !u.includes("archived="))).toBe(true);

    const events = await collectHistory(client, "ses_1", undefined, { includeUserMessages: true, apiVersion: 2 });
    expect(events.map((e) => e.event.type)).toEqual(["user", "assistant", "result"]);
    expect(events[0]!.event.type === "user" && events[0]!.event.text).toBe("First prompt");
    expect(events[1]!.event.type === "assistant" && events[1]!.event.text).toBe("Reply text");

    // Incremental catch-up from user checkpoint yields only subsequent events.
    const incremental = await collectHistory(
      client,
      "ses_1",
      { after: events[0]!.checkpoint },
      { includeUserMessages: true, apiVersion: 2 },
    );
    expect(incremental.map((e) => e.event.type)).toEqual(["assistant", "result"]);

    const savedYields = [];
    for await (const item of readOpenCodeSavedSession(client, sessions[0]!, {}, 2)) {
      savedYields.push(item);
    }
    expect(savedYields.map((y) => y.event.type)).toEqual(["user", "assistant", "result"]);
    vi.unstubAllGlobals();

    // attachOpenCodeHistory exercises apiVersion: 2 server path cleanly.
    const { baseUrl } = await startFakeOpenCodeV2Server({
      handle: (req, res) => {
        if ((req.url ?? "").startsWith("/api/session/ses_1/message")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [{
              id: "m2",
              type: "assistant",
              agent: "build",
              model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
              time: { created: 1002 },
              finish: "stop",
              content: [{ type: "text", text: "Attached" }],
            }],
          }));
          return;
        }
        res.writeHead(404).end();
      },
    });
    const bin = createFakeV2Script(baseUrl);
    const cwd = makeTempDir("oc-cwd-");
    const attachment = await attachOpenCodeHistory(
      createSessionRecord({
        providerType: "opencode",
        params: { sessionId: "ses_1", cwd },
        cwd,
        displayId: "ses_1",
      }),
      { config: { command: bin } },
    );
    expect(attachment.lastTurn).toBe("completed");
    await attachment.close();
  });

  it("sets archived=false on v2 saved history when includeArchived is false", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      requestedUrls.push(input);
      return Response.json({ data: [], cursor: { next: null } });
    }));
    const client = new OpenCodeClient("http://127.0.0.1:9999", "pw");
    for await (const _ of discoverOpenCodeSavedSessions(client, { includeArchived: false }, 2)) {
      // noop
    }
    expect(requestedUrls[0]).toContain("archived=false");
  });
});

describe("OpenCode v2 HTTP/SSE session", () => {
  it("creates session, streams deltas & tools, handles permission & form, and interrupts", async () => {
    const permissionReplies: unknown[] = [];
    const formReplies: unknown[] = [];
    const interrupts: string[] = [];
    const createdBodies: unknown[] = [];

    const { baseUrl } = await startFakeOpenCodeV2Server({
      handle: (req, res, bodyText, emitSse) => {
        const url = req.url ?? "/";
        if (url === "/api/session" && req.method === "POST") {
          createdBodies.push(JSON.parse(bodyText));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_v2_live" } }));
          return;
        }
        if (url === "/api/session/ses_v2_live/permission" || url === "/api/session/ses_v2_live/form") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        if (url === "/api/session/ses_v2_live/prompt" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: {
              id: "msg_user_1",
              sessionID: "ses_v2_live",
              time: { created: Date.now() },
              type: "user",
            },
          }));
          setTimeout(() => {
            emitSse({ id: "e1", created: 1, type: "session.execution.started", data: { sessionID: "ses_v2_live" } });
            emitSse({
              id: "e2",
              created: 2,
              type: "session.reasoning.delta",
              data: { sessionID: "ses_v2_live", assistantMessageID: "msg_asst_1", ordinal: 0, delta: "Plan..." },
            });
            emitSse({
              id: "e3",
              created: 3,
              type: "session.tool.input.started",
              data: { sessionID: "ses_v2_live", assistantMessageID: "msg_asst_1", id: "tool_1", name: "bash" },
            });
            emitSse({
              id: "e4",
              created: 4,
              type: "session.tool.called",
              data: { sessionID: "ses_v2_live", assistantMessageID: "msg_asst_1", id: "tool_1", input: { command: "ls" }, executed: false },
            });
            emitSse({
              id: "e5",
              created: 5,
              type: "permission.asked",
              data: { id: "perm_1", sessionID: "ses_v2_live", action: "bash", resources: ["ls"], message: "Run ls" },
            });
          }, 15);
          return;
        }
        if (url === "/api/session/ses_v2_live/permission/perm_1/reply" && req.method === "POST") {
          permissionReplies.push(JSON.parse(bodyText));
          res.writeHead(204).end();
          setTimeout(() => {
            emitSse({
              id: "e6",
              created: 6,
              type: "session.tool.success",
              data: {
                sessionID: "ses_v2_live",
                assistantMessageID: "msg_asst_1",
                id: "tool_1",
                content: [{ type: "text", text: "file.txt" }],
                executed: true,
              },
            });
            emitSse({
              id: "e7",
              created: 7,
              type: "form.created",
              data: {
                form: {
                  id: "frm_1",
                  sessionID: "ses_v2_live",
                  title: "Confirm",
                  fields: [
                    {
                      key: "env",
                      title: "Select target?",
                      type: "multiselect",
                      options: [{ value: "prod", label: "Production" }],
                      maxItems: 1,
                    },
                  ],
                },
              },
            });
          }, 15);
          return;
        }
        if (url === "/api/session/ses_v2_live/form/frm_1/reply" && req.method === "POST") {
          formReplies.push(JSON.parse(bodyText));
          res.writeHead(204).end();
          setTimeout(() => {
            emitSse({
              id: "e8",
              created: 8,
              type: "session.text.delta",
              data: { sessionID: "ses_v2_live", assistantMessageID: "msg_asst_1", ordinal: 2, delta: "Done!" },
            });
            emitSse({ id: "e9", created: 9, type: "session.execution.succeeded", data: { sessionID: "ses_v2_live" } });
          }, 15);
          return;
        }
        if (url === "/api/experimental/session/ses_v2_live/wait") {
          setTimeout(() => res.writeHead(204).end(), 200);
          return;
        }
        if (url.startsWith("/api/session/ses_v2_live/message")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: [
              {
                id: "msg_asst_1",
                type: "assistant",
                agent: "build",
                model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
                time: { created: Date.now() },
                finish: "stop",
                cost: 0.02,
                tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
                content: [{ type: "text", text: "Done!" }],
              },
              { id: "msg_user_1", type: "user", time: { created: Date.now() }, text: "Hi" },
            ],
          }));
          return;
        }
        if (url === "/api/session/ses_v2_live/interrupt" && req.method === "POST") {
          interrupts.push("ses_v2_live");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ interrupted: true }));
          return;
        }
        res.writeHead(404).end();
      },
    });

    const bin = createFakeV2Script(baseUrl);
    const cwd = makeTempDir("oc-cwd-");
    const events: Array<{ type: string; [k: string]: unknown }> = [];

    const session = await createOpenCodeSession({
      cwd,
      config: {
        command: bin,
        model: "anthropic/claude-sonnet-4-5",
        modelVariant: "high",
        modeId: "build",
      },
      onEvent: (ev) => {
        events.push(ev as unknown as { type: string; [k: string]: unknown });
      },
      onUserInputRequest: async (req) => {
        if (req.toolName === "AskUserQuestion") {
          return { allow: true, updatedInput: { answers: { "Select target?": "Production" } } };
        }
        return { allow: true };
      },
    });

    expect(createdBodies[0]).toEqual({
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" },
      agent: "build",
    });

    const handle = await session.send("Hi");
    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Done!");
    expect(result.costUsd).toBe(0.02);
    expect(permissionReplies).toEqual([{ decision: "once" }]);
    expect(formReplies).toEqual([{ answer: { env: ["prod"] } }]);
    expect(events.map((e) => e.type)).toEqual(["thinking", "tool_call", "tool_result", "assistant", "result"]);

    await session.interrupt();
    expect(interrupts).toEqual(["ses_v2_live"]);
    await session.close();
  });
});

describe("OpenCode v2 parse & execute", () => {
  it("extracts nested StructuredError messages from v2 run JSON lines", () => {
    const jsonl = JSON.stringify({
      type: "error",
      timestamp: 123,
      sessionID: "ses_err",
      error: { type: "provider.no-route", message: "No route for provider" },
    });
    const parsed = parseOpenCodeJsonl(jsonl);
    expect(parsed.isError).toBe(true);
    expect(parsed.errorMessage).toBe("No route for provider");
    expect(parsed.sessionId).toBe("ses_err");
    expect(parseOpenCodeStreamLine(jsonl)?.type).toBe("unknown");
  });

  it("invokes opencode v2 run with --standalone, #variant, and --auto", async () => {
    const dir = makeTempDir("oc-v2-exec-");
    const argsCapture = path.join(dir, "args.json");
    const bin = writeExecutable(
      path.join(dir, "opencode"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.3.0");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argsCapture)}, JSON.stringify(args));
console.log(JSON.stringify({ type: "text", sessionID: "ses_exec_v2", part: { text: "OK" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_exec_v2", part: { cost: 0.001, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0 } } } }));
`,
    );

    const result = await executeOpenCodeProvider({
      prompt: "hello",
      cwd: dir,
      model: "anthropic/claude-sonnet-4-5",
      config: {
        command: bin,
        modelVariant: "high",
        modeId: "plan",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("OK");
    const args = JSON.parse(fs.readFileSync(argsCapture, "utf8")) as string[];
    expect(args).toContain("--standalone");
    expect(args).toContain("--auto");
    expect(args).not.toContain("--variant");
    expect(args).toContain("anthropic/claude-sonnet-4-5#high");
    expect(args).toContain("--agent");
    expect(args).toContain("plan");
  });
});
