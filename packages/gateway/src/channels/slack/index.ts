import { defineChannel } from "../define.js";
import type { ChannelContext, OutboundMessage, SendResult } from "../../types.js";

interface SlackConfig {
  botToken: string;
  appToken: string;
  accountId?: string;
}

let app: any = null;
// Exported for mention detection by access control
export let botUserId: string | null = null;

export default defineChannel({
  id: "slack",
  label: "Slack",
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    streaming: true,
    streamingThrottleMs: 1000,
    threads: true,
    media: true,
    maxMessageLength: 40000,
  },

  async start(ctx: ChannelContext) {
    const config = ctx.config as unknown as SlackConfig;

    if (!config.botToken || !config.appToken) {
      throw new Error(
        "Slack channel requires both 'botToken' and 'appToken' in config (Socket Mode)",
      );
    }

    // Dynamic import
    let bolt: any;
    try {
      bolt = await (Function('return import("@slack/bolt")')() as Promise<any>);
    } catch {
      throw new Error(
        "Slack channel requires '@slack/bolt'. Install with: pnpm add @slack/bolt",
      );
    }

    const { App } = bolt;

    app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    // Get bot user ID for mention detection
    try {
      const authResult = await app.client.auth.test();
      botUserId = authResult.user_id ?? null;
    } catch {
      ctx.log.warn("Could not determine Slack bot user ID for mention detection");
    }

    app.message(async ({ event }: { event: any }) => {
      // Skip bot messages
      if (event.bot_id) return;

      const isDm = event.channel_type === "im";
      const isThread = !!event.thread_ts && event.thread_ts !== event.ts;

      let chatType: "direct" | "channel" | "thread" = "channel";
      if (isDm) chatType = "direct";
      else if (isThread) chatType = "thread";

      ctx.onMessage({
        messageId: event.ts,
        channel: "slack",
        accountId: config.accountId,
        senderId: event.user,
        chatType,
        target: event.channel,
        threadId: event.thread_ts,
        text: event.text ?? "",
        timestamp: Math.floor(parseFloat(event.ts) * 1000),
        raw: event,
      });
    });

    await app.start();
    ctx.log.info("Slack channel started (Socket Mode)");
  },

  async stop() {
    if (app) {
      await app.stop();
      app = null;
      botUserId = null;
    }
  },

  async status() {
    // Bolt doesn't expose a simple "connected" check, but if app exists we're running
    return { ok: app !== null };
  },

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!app) return { ok: false, error: "Slack app not initialized" };
    try {
      const opts: Record<string, unknown> = {
        channel: msg.target,
        text: msg.text,
      };
      if (msg.threadId) {
        opts.thread_ts = msg.threadId;
      }
      const result = await app.client.chat.postMessage(opts);
      return { ok: true, messageId: result.ts };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async editMessage(msg: OutboundMessage & { messageId: string }): Promise<SendResult> {
    if (!app) return { ok: false, error: "Slack app not initialized" };
    try {
      await app.client.chat.update({
        channel: msg.target,
        ts: msg.messageId,
        text: msg.text,
      });
      return { ok: true, messageId: msg.messageId };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
});
