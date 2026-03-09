import { defineChannel } from "../define.js";
import type { ChannelContext, OutboundMessage, SendResult } from "../../types.js";

interface DiscordConfig {
  token: string;
  accountId?: string;
}

let client: any = null;

export default defineChannel({
  id: "discord",
  label: "Discord",
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    streaming: true,
    streamingThrottleMs: 1000,
    threads: true,
    media: true,
    maxMessageLength: 2000,
  },

  async start(ctx: ChannelContext) {
    const config = ctx.config as unknown as DiscordConfig;

    if (!config.token) {
      throw new Error("Discord channel requires a 'token' in config");
    }

    // Dynamic import
    let discord: any;
    try {
      discord = await (Function('return import("discord.js")')() as Promise<any>);
    } catch {
      throw new Error(
        "Discord channel requires 'discord.js'. Install with: pnpm add discord.js",
      );
    }

    const { Client, GatewayIntentBits, Partials } = discord;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on("messageCreate", (msg: any) => {
      // Ignore bot messages
      if (msg.author.bot) return;
      if (!msg.content) return;

      let chatType: "direct" | "channel" | "thread" = "channel";
      if (msg.channel.isDMBased?.()) {
        chatType = "direct";
      } else if (msg.channel.isThread?.()) {
        chatType = "thread";
      }

      ctx.onMessage({
        messageId: msg.id,
        channel: "discord",
        accountId: config.accountId,
        senderId: msg.author.id,
        senderName: msg.author.displayName ?? msg.author.username,
        chatType,
        target: msg.channelId,
        threadId: msg.channel.isThread?.() ? msg.channelId : undefined,
        text: msg.content,
        timestamp: msg.createdTimestamp,
        raw: msg,
      });
    });

    await client.login(config.token);
    ctx.log.info("Discord channel started");
  },

  async stop() {
    if (client) {
      client.destroy();
      client = null;
    }
  },

  async status() {
    return { ok: client?.isReady?.() ?? false };
  },

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!client) return { ok: false, error: "Discord client not initialized" };
    try {
      const channel = await client.channels.fetch(msg.target);
      if (!channel?.isTextBased?.()) {
        return { ok: false, error: "Target is not a text channel" };
      }
      const result = await channel.send(msg.text);
      return { ok: true, messageId: result.id };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async editMessage(msg: OutboundMessage & { messageId: string }): Promise<SendResult> {
    if (!client) return { ok: false, error: "Discord client not initialized" };
    try {
      const channel = await client.channels.fetch(msg.target);
      if (!channel?.isTextBased?.()) {
        return { ok: false, error: "Target is not a text channel" };
      }
      const message = await channel.messages.fetch(msg.messageId);
      await message.edit(msg.text);
      return { ok: true, messageId: msg.messageId };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
});
