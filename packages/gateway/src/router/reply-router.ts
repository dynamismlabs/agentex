import { ChannelRegistry } from "../channels/registry.js";
import { chunkMessage } from "../channels/chunker.js";
import type {
  GatewayEventEmitter,
  SessionEntry,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";

export async function routeReply(
  text: string,
  attachments: OutboundAttachment[] | undefined,
  session: SessionEntry,
  channelRegistry: ChannelRegistry,
  events: GatewayEventEmitter,
): Promise<void> {
  const { lastRoute } = session;

  // 1. Look up plugin via registry
  const plugin = channelRegistry.getByInstance(
    lastRoute.channel,
    lastRoute.accountId,
  );
  if (!plugin) {
    events.emit(
      "message.outbound",
      {
        ok: false,
        error: `No channel plugin found for ${lastRoute.channel}${lastRoute.accountId ? `:${lastRoute.accountId}` : ""}`,
        channel: lastRoute.channel,
        target: lastRoute.target,
      },
      session.key,
    );
    return;
  }

  // 2. Get maxMessageLength from capabilities
  const maxLen = plugin.capabilities.maxMessageLength ?? Infinity;

  // 3. Chunk via chunkMessage() if needed
  const chunks = maxLen === Infinity ? [text] : chunkMessage(text, maxLen);

  // 4 & 5. Build OutboundMessage and send each chunk sequentially
  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;

    const outbound: OutboundMessage = {
      channel: lastRoute.channel,
      accountId: lastRoute.accountId,
      target: lastRoute.target,
      threadId: lastRoute.threadId,
      text: chunks[i]!,
      // Only include attachments on the last chunk
      ...(isLastChunk && attachments && attachments.length > 0
        ? { attachments }
        : {}),
    };

    const result = await plugin.send(outbound);

    // 6. Emit message.outbound event for each send
    events.emit(
      "message.outbound",
      {
        ok: result.ok,
        messageId: result.messageId,
        channel: lastRoute.channel,
        target: lastRoute.target,
        chunkIndex: i,
        totalChunks: chunks.length,
        ...(result.error ? { error: result.error } : {}),
      },
      session.key,
    );

    // 7. Handle { ok: false } — logged via event emission above
  }
}
