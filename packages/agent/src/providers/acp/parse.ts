import type { BaseStreamEventFields, StreamEvent } from "../../types.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Extract text from an ACP `ContentBlock` (a chunk update's `content`). */
export function extractContentText(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Record<string, unknown>;
  if (c["type"] === "text" && typeof c["text"] === "string") return c["text"];
  return null;
}

/** Extract displayable text from a tool call's `content` (ToolCallContent[]). */
export function extractToolContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (c["type"] === "content") {
      const inner = extractContentText(c["content"]);
      if (inner) parts.push(inner);
    } else if (c["type"] === "diff") {
      const nd = c["newText"] ?? c["new_text"];
      if (typeof nd === "string") parts.push(nd);
    }
    // Note: a "terminal" ToolCallContent carries only a `terminalId` (its output
    // must be fetched via the ACP terminal/* methods, which we don't implement),
    // so there's no inline text to extract here.
  }
  return parts.length ? parts.join("\n") : null;
}

export interface AcpBaseInfo {
  provider: string;
  sessionId: string | null;
  timestamp: string;
}

function makeBase(update: Record<string, unknown>, info: AcpBaseInfo): BaseStreamEventFields {
  // ACP doesn't expose per-event/message/turn ids, so those stay null; the
  // tool callId IS available, so tool_call/tool_result correlate properly.
  return {
    timestamp: info.timestamp,
    providerType: info.provider,
    sessionId: info.sessionId,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: update,
  };
}

/**
 * Map an ACP `session/update` payload (`params.update`) to an agentex
 * `StreamEvent`. Returns null for updates with no agentex equivalent (user
 * echoes, in-progress tool ticks). Unknown update kinds surface as
 * `type: "unknown"` for forward-compat.
 */
export function mapAcpUpdate(update: Record<string, unknown>, info: AcpBaseInfo): StreamEvent | null {
  const kind = update["sessionUpdate"];
  const base = makeBase(update, info);
  switch (kind) {
    case "agent_message_chunk": {
      const text = extractContentText(update["content"]);
      return text != null ? { type: "assistant", text, ...base } : null;
    }
    case "agent_thought_chunk": {
      const text = extractContentText(update["content"]);
      return text != null ? { type: "thinking", text, ...base } : null;
    }
    case "user_message_chunk":
      return null;
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: str(update["toolCallId"]),
        name: str(update["title"]) ?? str(update["kind"]) ?? "tool",
        input: update["rawInput"] ?? null,
        ...base,
      };
    case "tool_call_update": {
      const status = str(update["status"]);
      // Only emit a result once the tool reaches a terminal state.
      if (status === "completed" || status === "failed") {
        const content =
          extractToolContentText(update["content"]) ??
          (typeof update["rawOutput"] === "string" ? (update["rawOutput"] as string) : "");
        return {
          type: "tool_result",
          toolCallId: str(update["toolCallId"]),
          toolName: str(update["title"]),
          content,
          isError: status === "failed",
          exitCode: null,
          ...base,
        };
      }
      return null;
    }
    default:
      return { type: "unknown", subtype: str(kind) ?? "unknown", ...base };
  }
}

// NOTE: ACP's `usage_update` reports context-window `{ size, used }` rather than
// the input/output token split agentex's `TokenUsage` models, so we intentionally
// don't synthesize usage from ACP — `TurnResult.usage` stays undefined.

/** Map an ACP `stopReason` to an agentex TurnResult status. */
export function mapAcpStopReason(stopReason: string | undefined): TurnStatus {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "aborted";
    case "refusal":
      return "failed";
    case "max_tokens":
      return "max_budget";
    case "max_turn_requests":
      return "max_turns";
    default:
      return "completed";
  }
}

type TurnStatus = "completed" | "failed" | "max_turns" | "max_budget" | "aborted" | "timeout";
