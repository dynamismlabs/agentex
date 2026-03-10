import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { registerAdapter } from "@agentex/adapters";
import type { AdapterModule, ExecutionContext, ExecutionResult } from "@agentex/adapters";
import { createGateway } from "../../src/gateway.js";
import { defineChannel } from "../../src/channels/define.js";
import type {
  Gateway,
  ChannelPlugin,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  SendResult,
  GatewayEventPayload,
} from "../../src/types.js";
import { directMessage, threadMessage, resetMessageCounter } from "../fixtures/message-samples.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let portCounter = 39200;
function nextPort(): number {
  return portCounter++;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, pollMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function createMockAdapter(
  type: string,
  handler?: (ctx: ExecutionContext) => Promise<Partial<ExecutionResult>>,
): AdapterModule {
  return {
    type,
    async execute(ctx) {
      const partial = handler ? await handler(ctx) : {};
      return {
        runId: ctx.runId ?? "mock-run-id",
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
        summary: partial.summary ?? `Response to: ${ctx.prompt}`,
        sessionParams: partial.sessionParams ?? null,
        sessionDisplayId: null,
        clearSession: partial.clearSession ?? false,
        billingType: null,
        ...partial,
      };
    },
    async testEnvironment() {
      return {
        adapterType: type,
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock channel plugin factory
// ---------------------------------------------------------------------------

interface MockChannelTracker {
  startCalls: ChannelContext[];
  stopCalls: number;
  sendCalls: OutboundMessage[];
  editCalls: Array<OutboundMessage & { messageId: string }>;
  onMessage: ((msg: InboundMessage) => void) | null;
}

function createMockChannel(
  id = "test",
  opts?: { streaming?: boolean },
): ChannelPlugin & MockChannelTracker {
  // We need the closures to mutate `result` directly, so we create the object
  // first and then assign the ChannelPlugin methods that reference it.
  const result: ChannelPlugin & MockChannelTracker = {
    id,
    label: `Mock ${id}`,
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      streaming: opts?.streaming ?? false,
      streamingThrottleMs: 200,
    },
    startCalls: [],
    stopCalls: 0,
    sendCalls: [],
    editCalls: [],
    onMessage: null,
    async start(ctx: ChannelContext) {
      result.startCalls.push(ctx);
      result.onMessage = ctx.onMessage;
    },
    async stop() {
      result.stopCalls++;
    },
    async status() {
      return { ok: true };
    },
    async send(msg: OutboundMessage): Promise<SendResult> {
      result.sendCalls.push(msg);
      return { ok: true, messageId: `sent-${result.sendCalls.length}` };
    },
  };

  if (opts?.streaming) {
    result.editMessage = async (msg: OutboundMessage & { messageId: string }): Promise<SendResult> => {
      result.editCalls.push(msg);
      return { ok: true, messageId: msg.messageId };
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Message flow — end to end", () => {
  let gateway: Gateway;
  let stateDir: string;

  beforeEach(() => {
    resetMessageCounter();
  });

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* already stopped */ }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("full DM pipeline: inbound → adapter → reply", async () => {
    const adapter = createMockAdapter("mock-flow", async (ctx) => ({
      summary: `Agent says: got "${ctx.prompt}"`,
    }));
    registerAdapter(adapter);

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-flow-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-flow", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();

    mockChannel.onMessage!(directMessage({ text: "Hello from user" }));

    await waitFor(() => mockChannel.sendCalls.length > 0);

    expect(mockChannel.sendCalls.length).toBe(1);
    expect(mockChannel.sendCalls[0]!.text).toBe('Agent says: got "Hello from user"');
    expect(mockChannel.sendCalls[0]!.target).toBe("user-1");
  });

  it("emits gateway events during pipeline", async () => {
    const adapter = createMockAdapter("mock-events", async () => ({ summary: "Done" }));
    registerAdapter(adapter);

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-evt-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-events", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    const events: GatewayEventPayload[] = [];
    gateway.events.on("*", (payload) => events.push(payload));

    await gateway.start();
    mockChannel.onMessage!(directMessage());

    await waitFor(() => events.some((e) => e.type === "agent.complete"));

    const types = events.map((e) => e.type);
    expect(types).toContain("message.inbound");
    expect(types).toContain("session.created");
    expect(types).toContain("agent.start");
    expect(types).toContain("agent.complete");
  });

  it("access control blocks non-allowlisted sender", async () => {
    registerAdapter(createMockAdapter("mock-acl"));

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-acl-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-acl", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "allowlist", allowFrom: ["allowed-user"] } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();

    mockChannel.onMessage!(directMessage({ senderId: "blocked-user" }));

    // Wait a bit — nothing should happen
    await new Promise((r) => setTimeout(r, 200));
    expect(mockChannel.sendCalls.length).toBe(0);
  });

  it("access control allows allowlisted sender", async () => {
    registerAdapter(
      createMockAdapter("mock-acl-ok", async () => ({ summary: "Allowed response" })),
    );

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-acl-ok-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-acl-ok", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "allowlist", allowFrom: ["allowed-user"] } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();
    mockChannel.onMessage!(directMessage({ senderId: "allowed-user" }));

    await waitFor(() => mockChannel.sendCalls.length > 0);

    expect(mockChannel.sendCalls[0]!.text).toBe("Allowed response");
  });

  it("session is preserved across messages", async () => {
    let callCount = 0;
    const adapter = createMockAdapter("mock-sess", async (ctx) => {
      callCount++;
      if (callCount === 1) {
        return { summary: "First response", sessionParams: { sessionId: "sid-123" } };
      }
      return { summary: `Session has: ${JSON.stringify(ctx.sessionParams)}` };
    });
    registerAdapter(adapter);

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-sess-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-sess", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();

    // First message — adapter sets sessionParams
    mockChannel.onMessage!(directMessage({ text: "First" }));
    await waitFor(() => mockChannel.sendCalls.length >= 1);

    // Second message — adapter should receive the session params
    mockChannel.onMessage!(directMessage({ text: "Second" }));
    await waitFor(() => mockChannel.sendCalls.length >= 2);

    expect(mockChannel.sendCalls[1]!.text).toContain("sid-123");
  });

  it("multi-agent routing dispatches to correct adapter", async () => {
    const coderCalls: string[] = [];
    const reviewerCalls: string[] = [];

    registerAdapter(
      createMockAdapter("mock-coder", async (ctx) => {
        coderCalls.push(ctx.prompt);
        return { summary: "Coder response" };
      }),
    );
    registerAdapter(
      createMockAdapter("mock-reviewer", async (ctx) => {
        reviewerCalls.push(ctx.prompt);
        return { summary: "Reviewer response" };
      }),
    );

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-multi-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-coder", cwd: "/tmp" },
        agents: {
          coder: { adapter: "mock-coder", cwd: "/tmp/coder" },
          reviewer: { adapter: "mock-reviewer", cwd: "/tmp/reviewer" },
        },
        routing: {
          rules: [{ match: { channel: "test", chatType: "thread" }, agent: "reviewer" }],
          default: "coder",
        },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" }, groups: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();

    // DM → default → coder
    mockChannel.onMessage!(directMessage({ text: "Write code" }));
    await waitFor(() => mockChannel.sendCalls.length >= 1);
    expect(coderCalls.length).toBe(1);
    expect(reviewerCalls.length).toBe(0);

    // Thread → rule match → reviewer
    mockChannel.onMessage!(threadMessage({ text: "Review this" }));
    await waitFor(() => mockChannel.sendCalls.length >= 2);
    expect(reviewerCalls.length).toBe(1);
  });

  it("streaming channel receives placeholder + edits + finalize", async () => {
    registerAdapter(
      createMockAdapter("mock-stream", async (ctx) => {
        if (ctx.onEvent) {
          await ctx.onEvent({ type: "assistant", text: "Streaming ", timestamp: new Date().toISOString() });
          await ctx.onEvent({ type: "assistant", text: "response", timestamp: new Date().toISOString() });
        }
        return { summary: "Streaming response" };
      }),
    );

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-strm-"));
    const mockChannel = createMockChannel("test", { streaming: true });

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-stream", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();
    mockChannel.onMessage!(directMessage({ text: "Stream me" }));

    // Wait for send (placeholder) and at least one edit
    await waitFor(() => mockChannel.sendCalls.length > 0 && mockChannel.editCalls.length > 0, 5000);

    // Placeholder was sent
    expect(mockChannel.sendCalls.length).toBeGreaterThanOrEqual(1);

    // Final edit should contain the complete response
    const lastEdit = mockChannel.editCalls[mockChannel.editCalls.length - 1];
    expect(lastEdit!.text).toBe("Streaming response");
  });

  it("pairing flow: unapproved sender triggers pairing event", async () => {
    registerAdapter(createMockAdapter("mock-pair"));

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-pair-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-pair", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "pairing" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    const events: GatewayEventPayload[] = [];
    gateway.events.on("*", (payload) => events.push(payload));

    await gateway.start();
    mockChannel.onMessage!(directMessage({ senderId: "new-user", text: "Hello" }));

    await waitFor(() => events.some((e) => e.type === "pairing.requested"));

    const pe = events.find((e) => e.type === "pairing.requested")!;
    expect(pe.data.senderId).toBe("new-user");
    expect(pe.data.channel).toBe("test");
    expect(mockChannel.sendCalls.length).toBe(0);
  });

  it("adapter error sends error message to channel", async () => {
    registerAdapter(
      createMockAdapter("mock-err", async () => {
        throw new Error("Adapter exploded");
      }),
    );

    stateDir = await mkdtemp(resolve(tmpdir(), "gw-err-"));
    const mockChannel = createMockChannel("test");

    gateway = createGateway({
      config: {
        gateway: { bind: "loopback", port: nextPort(), auth: { mode: "none" } },
        agent: { adapter: "mock-err", cwd: "/tmp" },
        sessions: { dmScope: "per-peer" },
        queue: { mode: "queue", maxQueueDepth: 10 },
        channels: { test: { dm: { policy: "open" } } },
      },
      channels: [mockChannel],
      stateDir,
    });

    await gateway.start();
    mockChannel.onMessage!(directMessage({ text: "Trigger error" }));

    await waitFor(() => mockChannel.sendCalls.length > 0, 3000);

    expect(mockChannel.sendCalls[0]!.text).toContain("Adapter exploded");
  });
});
