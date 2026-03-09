import type { ChannelPlugin, ReplyRoute, OutboundMessage } from "../types.js";

export class ResponseStreamer {
  private messageId: string | null = null;
  private buffer = "";
  private interval: ReturnType<typeof setInterval> | null = null;
  private plugin: ChannelPlugin;
  private route: ReplyRoute;
  private throttleMs: number;

  constructor(plugin: ChannelPlugin, route: ReplyRoute) {
    this.plugin = plugin;
    this.route = route;
    this.throttleMs = plugin.capabilities.streamingThrottleMs ?? 1000;
  }

  async start(): Promise<void> {
    const placeholder: OutboundMessage = {
      channel: this.route.channel,
      accountId: this.route.accountId,
      target: this.route.target,
      threadId: this.route.threadId,
      text: "\u258D",
    };

    const result = await this.plugin.send(placeholder);
    if (result.ok && result.messageId) {
      this.messageId = result.messageId;
    }

    this.interval = setInterval(() => {
      void this.editWithBuffer();
    }, this.throttleMs);
  }

  appendText(text: string): void {
    this.buffer += text;
  }

  async finalize(fullText: string): Promise<void> {
    this.dispose();

    if (this.messageId && this.plugin.editMessage) {
      await this.plugin.editMessage({
        channel: this.route.channel,
        accountId: this.route.accountId,
        target: this.route.target,
        threadId: this.route.threadId,
        text: fullText,
        messageId: this.messageId,
      });
    }
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async editWithBuffer(): Promise<void> {
    if (!this.messageId || !this.plugin.editMessage || this.buffer.length === 0) {
      return;
    }

    await this.plugin.editMessage({
      channel: this.route.channel,
      accountId: this.route.accountId,
      target: this.route.target,
      threadId: this.route.threadId,
      text: this.buffer + "\u258D",
      messageId: this.messageId,
    });
  }
}
