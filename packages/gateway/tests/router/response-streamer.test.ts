import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResponseStreamer } from "../../src/router/response-streamer.js";
import type {
  ChannelPlugin,
  ChannelStatus,
  OutboundMessage,
  SendResult,
  ReplyRoute,
} from "../../src/types.js";

function makePlugin(
  overrides?: Partial<ChannelPlugin>,
): ChannelPlugin {
  return {
    id: "slack",
    label: "Slack",
    capabilities: {
      chatTypes: ["direct"],
      streaming: true,
      streamingThrottleMs: 500,
    },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<ChannelStatus> => ({ ok: true })),
    send: vi.fn(
      async (_msg: OutboundMessage): Promise<SendResult> => ({
        ok: true,
        messageId: "msg-42",
      }),
    ),
    editMessage: vi.fn(
      async (
        _msg: OutboundMessage & { messageId: string },
      ): Promise<SendResult> => ({
        ok: true,
        messageId: "msg-42",
      }),
    ),
    ...overrides,
  };
}

function makeRoute(): ReplyRoute {
  return {
    channel: "slack",
    target: "C123",
    threadId: "t1",
  };
}

describe("ResponseStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends placeholder on start", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    expect(plugin.send).toHaveBeenCalledTimes(1);
    expect(plugin.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        target: "C123",
        threadId: "t1",
        text: "\u258D",
      }),
    );

    streamer.dispose();
  });

  it("edits message with buffer content at throttle interval", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.appendText("Hello ");
    streamer.appendText("world");

    // Advance past the throttle interval (500ms from mock plugin)
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello world\u258D",
        messageId: "msg-42",
      }),
    );

    streamer.dispose();
  });

  it("does not edit when buffer is empty", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    // Advance past throttle without appending text
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.editMessage).not.toHaveBeenCalled();

    streamer.dispose();
  });

  it("finalize sends complete text and clears interval", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.appendText("partial");

    await streamer.finalize("Full response text");

    expect(plugin.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Full response text",
        messageId: "msg-42",
      }),
    );

    // After finalize, no more edits should happen
    vi.mocked(plugin.editMessage!).mockClear();
    streamer.appendText("more text");
    await vi.advanceTimersByTimeAsync(1000);

    expect(plugin.editMessage).not.toHaveBeenCalled();
  });

  it("dispose clears the interval", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.dispose();

    streamer.appendText("text after dispose");
    await vi.advanceTimersByTimeAsync(1000);

    // editMessage should not be called after dispose
    expect(plugin.editMessage).not.toHaveBeenCalled();
  });

  it("uses default throttle when streamingThrottleMs is not set", async () => {
    const plugin = makePlugin({
      capabilities: {
        chatTypes: ["direct"],
        streaming: true,
        // no streamingThrottleMs — should default to 1000
      },
    });
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.appendText("data");

    // At 500ms, should not have edited yet (default is 1000ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.editMessage).not.toHaveBeenCalled();

    // At 1000ms, should have edited
    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.editMessage).toHaveBeenCalledTimes(1);

    streamer.dispose();
  });

  it("handles send returning no messageId gracefully", async () => {
    const plugin = makePlugin({
      send: vi.fn(
        async (_msg: OutboundMessage): Promise<SendResult> => ({
          ok: true,
          // no messageId
        }),
      ),
    });
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.appendText("text");
    await vi.advanceTimersByTimeAsync(500);

    // editMessage should not be called because we have no messageId
    expect(plugin.editMessage).not.toHaveBeenCalled();

    streamer.dispose();
  });

  it("finalize skips edit when plugin has no editMessage", async () => {
    const plugin = makePlugin();
    // Remove editMessage
    delete (plugin as Partial<ChannelPlugin>).editMessage;

    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    // Should not throw
    await streamer.finalize("Full text");

    // No errors — just a clean no-op
    streamer.dispose();
  });

  it("multiple throttle intervals accumulate buffer", async () => {
    const plugin = makePlugin();
    const route = makeRoute();
    const streamer = new ResponseStreamer(plugin, route);

    await streamer.start();

    streamer.appendText("chunk1 ");
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "chunk1 \u258D",
      }),
    );

    streamer.appendText("chunk2 ");
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "chunk1 chunk2 \u258D",
      }),
    );

    streamer.dispose();
  });
});
