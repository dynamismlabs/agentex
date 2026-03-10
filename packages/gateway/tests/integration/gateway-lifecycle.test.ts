import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { registerProvider } from "@agentex/agent";
import type { ProviderModule } from "@agentex/agent";
import { createGateway } from "../../src/gateway.js";
import { defineChannel } from "../../src/channels/define.js";
import type { Gateway, ChannelPlugin, ChannelContext } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let portCounter = 39100;
function nextPort(): number {
  return portCounter++;
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

const mockProvider: ProviderModule = {
  type: "mock-lifecycle",
  async execute() {
    return {
      runId: "mock-run-id",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      errorMessage: null,
      errorCode: null,
      costUsd: null,
      model: "mock-v1",
      summary: "Mock response",
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  },
  async testEnvironment() {
    return {
      providerType: "mock-lifecycle",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Mock channel plugin
// ---------------------------------------------------------------------------

function createMockChannel(): ChannelPlugin & {
  startCalls: ChannelContext[];
  stopCalls: number;
  sendCalls: Array<{ target: string; text: string }>;
} {
  const result: ChannelPlugin & {
    startCalls: ChannelContext[];
    stopCalls: number;
    sendCalls: Array<{ target: string; text: string }>;
  } = {
    id: "test",
    label: "Test Channel",
    capabilities: { chatTypes: ["direct", "group"], streaming: false },
    startCalls: [],
    stopCalls: 0,
    sendCalls: [],
    async start(ctx: ChannelContext) {
      result.startCalls.push(ctx);
    },
    async stop() {
      result.stopCalls++;
    },
    async status() {
      return { ok: true };
    },
    async send(msg) {
      result.sendCalls.push({ target: msg.target, text: msg.text });
      return { ok: true, messageId: "sent-1" };
    },
  };

  return result;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway lifecycle", () => {
  let gateway: Gateway;
  let stateDir: string;

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* already stopped */ }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("starts and channel start() is called", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-lc-"));
    const mockChannel = createMockChannel();

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: {} },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();

    expect(mockChannel.startCalls.length).toBe(1);
    expect(mockChannel.startCalls[0]!.onMessage).toBeTypeOf("function");
  });

  it("GET /healthz returns 200", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-hz-"));
    const port = nextPort();

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port, auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    await gateway.start();

    const res = await httpGet(port, "/healthz");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it("stops cleanly — channels stopped, server closed", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-stop-"));
    const mockChannel = createMockChannel();

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: {} },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();
    expect(mockChannel.startCalls.length).toBe(1);

    await gateway.stop();
    expect(mockChannel.stopCalls).toBe(1);
  });

  it("throws on double start", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-dbl-"));

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    await gateway.start();
    await expect(gateway.start()).rejects.toThrow("already started");
  });

  it("throws on password auth mode", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-pw-"));

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "password" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    await expect(gateway.start()).rejects.toThrow("Password auth");
  });

  it("stop is idempotent", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-idem-"));

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    await gateway.start();
    await gateway.stop();
    await gateway.stop(); // should not throw
  });

  it("config is accessible before start", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-cfg-"));
    const port = nextPort();

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port, auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    expect(gateway.config.gateway.port).toBe(port);
    expect(gateway.config.agent.provider).toBe("mock-lifecycle");
  });

  it("events emitter is accessible before start", async () => {
    registerProvider(mockProvider);
    stateDir = await mkdtemp(resolve(tmpdir(), "gw-evt-"));

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { provider: "mock-lifecycle", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: {},
      },
      stateDir,
    });

    expect(gateway.events).toBeDefined();
    expect(gateway.events.on).toBeTypeOf("function");
    expect(gateway.events.emit).toBeTypeOf("function");
  });
});
