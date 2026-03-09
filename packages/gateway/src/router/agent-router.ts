import type { InboundMessage, RoutingConfig } from "../types.js";

/**
 * Match an inbound message against routing rules to determine which agent handles it.
 *
 * Rules are evaluated in order — first match wins.
 * Each rule's `match` fields are AND-combined (omitted fields are wildcards).
 * If no rule matches, returns `routing.default` or "main" if no routing config.
 */
export function resolveAgent(
  msg: InboundMessage,
  routing?: RoutingConfig,
): string {
  if (!routing) {
    return "main";
  }

  for (const rule of routing.rules) {
    const { match } = rule;
    let isMatch = true;

    if (match.channel !== undefined && match.channel !== msg.channel) {
      isMatch = false;
    }
    if (match.target !== undefined && match.target !== msg.target) {
      isMatch = false;
    }
    if (match.chatType !== undefined && match.chatType !== msg.chatType) {
      isMatch = false;
    }

    if (isMatch) {
      return rule.agent;
    }
  }

  return routing.default;
}
