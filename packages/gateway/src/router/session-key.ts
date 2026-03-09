import type { InboundMessage, SessionsConfig } from "../types.js";

/**
 * Resolve the canonical peer ID for a sender, using identity links if available.
 *
 * Identity links map canonical names to arrays of `channel:senderId` strings.
 * If the sender matches any linked identity, the canonical name is returned.
 * Otherwise falls back to the raw senderId.
 */
export function resolveCanonicalPeerId(
  senderId: string,
  channel: string,
  identityLinks?: Record<string, string[]>,
): string {
  if (!identityLinks) return senderId;

  const needle = `${channel}:${senderId}`;
  for (const [canonical, links] of Object.entries(identityLinks)) {
    if (links.includes(needle)) {
      return canonical;
    }
  }
  return senderId;
}

/**
 * Build a session key from an inbound message + config + agent ID.
 *
 * Session key formats:
 * - main:           agent:<agentId>:main
 * - per-peer:       agent:<agentId>:direct:<canonicalPeerId>
 * - per-channel-peer: agent:<agentId>:<channel>:direct:<senderId>
 * - groups:         agent:<agentId>:<channel>:group:<targetId>
 */
export function resolveSessionKey(
  msg: InboundMessage,
  config: SessionsConfig,
  agentId: string,
): string {
  // Group/channel/thread messages always scope by channel + target
  if (msg.chatType !== "direct") {
    return `agent:${agentId}:${msg.channel}:group:${msg.target}`;
  }

  // DM scoping modes
  switch (config.dmScope) {
    case "main":
      return `agent:${agentId}:main`;

    case "per-peer": {
      const peerId = resolveCanonicalPeerId(
        msg.senderId,
        msg.channel,
        config.identityLinks,
      );
      return `agent:${agentId}:direct:${peerId}`;
    }

    case "per-channel-peer":
      return `agent:${agentId}:${msg.channel}:direct:${msg.senderId}`;

    default:
      return `agent:${agentId}:main`;
  }
}
