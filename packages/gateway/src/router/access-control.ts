import { randomUUID } from "node:crypto";
import type {
  AccessDecision,
  ChannelAccessConfig,
  InboundMessage,
  PairingRequest,
} from "../types.js";

// ---------------------------------------------------------------------------
// checkAccess — pure function
// ---------------------------------------------------------------------------

export function checkAccess(
  msg: InboundMessage,
  channelConfig: ChannelAccessConfig,
): AccessDecision {
  if (msg.chatType === "direct") {
    return checkDmAccess(msg, channelConfig);
  }
  // group / channel / thread
  return checkGroupAccess(msg, channelConfig);
}

function checkDmAccess(
  msg: InboundMessage,
  config: ChannelAccessConfig,
): AccessDecision {
  const policy = config.dm?.policy ?? "pairing";

  switch (policy) {
    case "disabled":
      return { allowed: false, reason: "DMs are disabled for this channel" };

    case "open":
      return { allowed: true };

    case "allowlist": {
      const allowed = config.dm?.allowFrom?.includes(msg.senderId) ?? false;
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: `Sender ${msg.senderId} is not in the DM allowlist` };
    }

    case "pairing":
      // Pairing is handled externally — we just signal that it's needed
      return { allowed: false, pendingPairing: true, reason: "Pairing approval required" };

    default:
      return { allowed: false, reason: `Unknown DM policy: ${String(policy)}` };
  }
}

function checkGroupAccess(
  msg: InboundMessage,
  config: ChannelAccessConfig,
): AccessDecision {
  const policy = config.groups?.policy ?? "mention";

  switch (policy) {
    case "disabled":
      return { allowed: false, reason: "Group messages are disabled for this channel" };

    case "open":
      return { allowed: true };

    case "allowlist": {
      const allowed = config.groups?.allowFrom?.includes(msg.target) ?? false;
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: `Group ${msg.target} is not in the allowlist` };
    }

    case "mention": {
      const pattern = config.groups?.mentionPattern;
      if (!pattern) {
        // No mention pattern configured — allow (caller should set this)
        return { allowed: true };
      }
      const mentioned = msg.text.includes(pattern);
      return mentioned
        ? { allowed: true }
        : { allowed: false, reason: "Bot was not mentioned" };
    }

    default:
      return { allowed: false, reason: `Unknown group policy: ${String(policy)}` };
  }
}

// ---------------------------------------------------------------------------
// PairingStore — in-memory pairing request management
// ---------------------------------------------------------------------------

export class PairingStore {
  private pairings = new Map<string, PairingRequest>();

  request(msg: InboundMessage): PairingRequest {
    // Check if there's an existing pairing for this sender on this channel
    const existing = this.findBySender(msg.channel, msg.senderId);
    if (existing) {
      existing.heldMessages.push(msg);
      return existing;
    }

    const pairing: PairingRequest = {
      id: randomUUID(),
      channel: msg.channel,
      accountId: msg.accountId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      heldMessages: [msg],
      requestedAt: Date.now(),
    };
    this.pairings.set(pairing.id, pairing);
    return pairing;
  }

  approve(id: string): InboundMessage[] {
    const pairing = this.pairings.get(id);
    if (!pairing) {
      return [];
    }
    const messages = pairing.heldMessages;
    this.pairings.delete(id);
    return messages;
  }

  deny(id: string): void {
    this.pairings.delete(id);
  }

  get(id: string): PairingRequest | undefined {
    return this.pairings.get(id);
  }

  getAll(): PairingRequest[] {
    return Array.from(this.pairings.values());
  }

  findBySender(channel: string, senderId: string): PairingRequest | undefined {
    for (const pairing of this.pairings.values()) {
      if (pairing.channel === channel && pairing.senderId === senderId) {
        return pairing;
      }
    }
    return undefined;
  }
}
