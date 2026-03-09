import { defineChannel } from "../define.js";
import type { ChannelContext, OutboundMessage, SendResult } from "../../types.js";

interface TelegramConfig {
  token: string;
  accountId?: string;
}

let bot: any = null;

export default defineChannel({
  id: "telegram",
  label: "Telegram",
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    streaming: true,
    streamingThrottleMs: 1000,
    threads: true,
    media: true,
    maxMessageLength: 4096,
  },

  async start(ctx: ChannelContext) {
    const config = ctx.config as unknown as TelegramConfig;

    if (!config.token) {
      throw new Error("Telegram channel requires a 'token' in config");
    }

    // Dynamic import
    let TelegramBot: any;
    try {
      const mod = await (Function('return import("node-telegram-bot-api")')() as Promise<any>);
      TelegramBot = mod.default ?? mod;
    } catch {
      throw new Error(
        "Telegram channel requires 'node-telegram-bot-api'. Install with: pnpm add node-telegram-bot-api",
      );
    }

    bot = new TelegramBot(config.token, { polling: true });

    bot.on("message", (msg: any) => {
      if (!msg.text) return;

      const chatType =
        msg.chat.type === "private"
          ? "direct"
          : msg.chat.type === "supergroup" && msg.message_thread_id
            ? "thread"
            : "group";

      ctx.onMessage({
        messageId: String(msg.message_id),
        channel: "telegram",
        accountId: config.accountId,
        senderId: String(msg.from?.id ?? "unknown"),
        senderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined,
        chatType: chatType as "direct" | "group" | "thread",
        target: String(msg.chat.id),
        threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
        text: msg.text,
        timestamp: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        raw: msg,
      });
    });

    ctx.log.info("Telegram channel started (polling mode)");
  },

  async stop() {
    if (bot) {
      await bot.stopPolling();
      bot = null;
    }
  },

  async status() {
    return { ok: bot?.isPolling?.() ?? false };
  },

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!bot) return { ok: false, error: "Telegram bot not initialized" };
    try {
      const opts: Record<string, unknown> = { parse_mode: "Markdown" };
      if (msg.threadId) {
        opts.message_thread_id = Number(msg.threadId);
      }
      const result = await bot.sendMessage(msg.target, msg.text, opts);
      return { ok: true, messageId: String(result.message_id) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async editMessage(msg: OutboundMessage & { messageId: string }): Promise<SendResult> {
    if (!bot) return { ok: false, error: "Telegram bot not initialized" };
    try {
      await bot.editMessageText(msg.text, {
        chat_id: msg.target,
        message_id: Number(msg.messageId),
        parse_mode: "Markdown",
      });
      return { ok: true, messageId: msg.messageId };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
});
