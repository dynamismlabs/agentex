import { describe, it, expect, vi } from "vitest";
import { routeReply } from "../../src/router/reply-router.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type {
  ChannelPlugin,
  ChannelStatus,
  OutboundMessage,
  SendResult,
  SessionEntry,
  GatewayEventEmitter,
  OutboundAttachment,
} from "../../src/types.js";

function makePlugin(
  id: string,
  overrides?: Partial<ChannelPlugin>,
): ChannelPlugin {
  return {
    id,
    label: id,
    capabilities: { chatTypes: ["direct"], maxMessageLength: 100 },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<ChannelStatus> => ({ ok: true })),
    send: vi.fn(
      async (_msg: OutboundMessage): Promise<SendResult> => ({
        ok: true,
        messageId: "msg-1",
      }),
    ),
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    key: "session-1",
    sessionParams: null,
    lastChannel: "slack",
    lastRoute: {
      channel: "slack",
      target: "C123",
      threadId: "t1",
    },
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function makeEvents(): GatewayEventEmitter {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

describe("routeReply", () => {
  it("looks up the correct plugin via registry", async () => {
    const plugin = makePlugin("slack");
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    await routeReply("Hello", undefined, session, registry, events);

    expect(plugin.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        target: "C123",
        threadId: "t1",
        text: "Hello",
      }),
    );
  });

  it("looks up plugin with accountId", async () => {
    const plugin = makePlugin("slack");
    const registry = new ChannelRegistry();
    registry.register(plugin, "work");

    const session = makeSession({
      lastRoute: {
        channel: "slack",
        accountId: "work",
        target: "C123",
      },
    });
    const events = makeEvents();

    await routeReply("Hi", undefined, session, registry, events);

    expect(plugin.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "work",
        target: "C123",
        text: "Hi",
      }),
    );
  });

  it("emits error event when plugin not found", async () => {
    const registry = new ChannelRegistry();
    const session = makeSession();
    const events = makeEvents();

    await routeReply("Hello", undefined, session, registry, events);

    expect(events.emit).toHaveBeenCalledWith(
      "message.outbound",
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("No channel plugin found"),
      }),
      "session-1",
    );
  });

  it("chunks long messages and sends sequentially", async () => {
    const sendCalls: string[] = [];
    const plugin = makePlugin("slack", {
      capabilities: { chatTypes: ["direct"], maxMessageLength: 20 },
      send: vi.fn(async (msg: OutboundMessage): Promise<SendResult> => {
        sendCalls.push(msg.text);
        return { ok: true, messageId: `msg-${sendCalls.length}` };
      }),
    });
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    // Create a message that must be chunked (> 20 chars)
    const longText = "A".repeat(15) + "\n\n" + "B".repeat(15);

    await routeReply(longText, undefined, session, registry, events);

    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    // Verify all chunks were sent
    expect(plugin.send).toHaveBeenCalledTimes(sendCalls.length);
  });

  it("emits message.outbound event for each chunk sent", async () => {
    const plugin = makePlugin("slack", {
      capabilities: { chatTypes: ["direct"], maxMessageLength: 20 },
      send: vi.fn(
        async (_msg: OutboundMessage): Promise<SendResult> => ({
          ok: true,
          messageId: "msg-1",
        }),
      ),
    });
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    const longText = "A".repeat(15) + "\n\n" + "B".repeat(15);
    await routeReply(longText, undefined, session, registry, events);

    const sendCount = vi.mocked(plugin.send).mock.calls.length;
    expect(vi.mocked(events.emit).mock.calls.length).toBe(sendCount);

    for (const call of vi.mocked(events.emit).mock.calls) {
      expect(call[0]).toBe("message.outbound");
      expect(call[2]).toBe("session-1");
    }
  });

  it("attaches attachments only on last chunk", async () => {
    const sentMessages: OutboundMessage[] = [];
    const plugin = makePlugin("slack", {
      capabilities: { chatTypes: ["direct"], maxMessageLength: 20 },
      send: vi.fn(async (msg: OutboundMessage): Promise<SendResult> => {
        sentMessages.push(msg);
        return { ok: true, messageId: "msg-1" };
      }),
    });
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    const longText = "A".repeat(15) + "\n\n" + "B".repeat(15);
    const attachments: OutboundAttachment[] = [
      { type: "file", filename: "test.txt", source: "/tmp/test.txt" },
    ];

    await routeReply(longText, attachments, session, registry, events);

    expect(sentMessages.length).toBeGreaterThanOrEqual(2);

    // All chunks except last should have no attachments
    for (let i = 0; i < sentMessages.length - 1; i++) {
      expect(sentMessages[i]!.attachments).toBeUndefined();
    }

    // Last chunk should have the attachments
    expect(sentMessages[sentMessages.length - 1]!.attachments).toEqual(
      attachments,
    );
  });

  it("sends short message as single chunk without splitting", async () => {
    const plugin = makePlugin("slack");
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    await routeReply("Short", undefined, session, registry, events);

    expect(plugin.send).toHaveBeenCalledTimes(1);
    expect(plugin.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Short" }),
    );
  });

  it("emits event with error info on send failure", async () => {
    const plugin = makePlugin("slack", {
      send: vi.fn(
        async (_msg: OutboundMessage): Promise<SendResult> => ({
          ok: false,
          error: "rate limited",
        }),
      ),
    });
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    await routeReply("Hello", undefined, session, registry, events);

    expect(events.emit).toHaveBeenCalledWith(
      "message.outbound",
      expect.objectContaining({
        ok: false,
        error: "rate limited",
      }),
      "session-1",
    );
  });

  it("skips chunking when maxMessageLength is not set", async () => {
    const plugin = makePlugin("slack", {
      capabilities: { chatTypes: ["direct"] }, // no maxMessageLength
      send: vi.fn(
        async (_msg: OutboundMessage): Promise<SendResult> => ({
          ok: true,
          messageId: "msg-1",
        }),
      ),
    });
    const registry = new ChannelRegistry();
    registry.register(plugin);

    const session = makeSession();
    const events = makeEvents();

    const longText = "A".repeat(5000);
    await routeReply(longText, undefined, session, registry, events);

    expect(plugin.send).toHaveBeenCalledTimes(1);
    expect(plugin.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: longText }),
    );
  });
});
