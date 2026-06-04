import type { BaseStreamEventFields, StreamEvent, TokenUsage } from "../../types.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export interface OcBaseInfo {
  provider: string;
  sessionId: string | null;
  timestamp: string;
}

function makeBase(raw: Record<string, unknown>, info: OcBaseInfo): BaseStreamEventFields {
  return {
    timestamp: info.timestamp,
    providerType: info.provider,
    sessionId: info.sessionId,
    messageId: str(raw["messageID"]),
    eventId: str(raw["id"]),
    turnId: null,
    parentToolCallId: null,
    raw,
  };
}

/** True if a text part should be surfaced (skip synthetic / ignored parts). */
function isVisibleText(part: Record<string, unknown>): boolean {
  return part["synthetic"] !== true && part["ignored"] !== true;
}

/** Concatenate the visible assistant text across a message's parts. */
export function assistantTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    const part = rec(p);
    if (!part) continue;
    if (part["type"] === "text" && isVisibleText(part) && typeof part["text"] === "string") {
      out.push(part["text"]);
    }
  }
  return out.join("");
}

/** Status of an opencode AssistantMessage → TurnResult status. */
export function turnStatusFromMessage(info: unknown): "completed" | "failed" {
  const m = rec(info);
  return m && m["error"] ? "failed" : "completed";
}

/** Map opencode's `tokens` (+ model identity) to agentex usage. */
export function usageFromMessage(info: unknown): Record<string, TokenUsage> | undefined {
  const m = rec(info);
  if (!m) return undefined;
  const tokens = rec(m["tokens"]);
  if (!tokens) return undefined;
  const input = num(tokens["input"]);
  const output = num(tokens["output"]);
  if (input == null && output == null) return undefined;
  const cache = rec(tokens["cache"]);
  const model =
    [str(m["providerID"]), str(m["modelID"])].filter(Boolean).join("/") || "opencode";
  const usage: TokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  const cacheRead = cache ? num(cache["read"]) : null;
  if (cacheRead != null) usage.cachedInputTokens = cacheRead;
  return { [model]: usage };
}

/** Build a `tool_call` StreamEvent for an opencode ToolPart (the announcement,
 *  emitted on first sight regardless of state). */
export function mapOpenCodeToolCall(part: Record<string, unknown>, info: OcBaseInfo): StreamEvent {
  const state = rec(part["state"]);
  return {
    type: "tool_call",
    toolCallId: str(part["callID"]),
    name: str(part["tool"]) ?? "tool",
    input: state ? (state["input"] ?? null) : null,
    ...makeBase(part, info),
  };
}

/**
 * Map an opencode `Part` to a StreamEvent. Text/reasoning parts carry the text
 * to emit in `textOverride` (the session passes a computed delta so streaming
 * isn't re-emitted in full). Tool parts map by their state status. Returns null
 * for parts with no agentex equivalent.
 */
export function mapOpenCodePart(
  part: Record<string, unknown>,
  info: OcBaseInfo,
  textOverride?: string,
): StreamEvent | null {
  const base = makeBase(part, info);
  const type = part["type"];

  if (type === "text") {
    if (!isVisibleText(part)) return null;
    const text = textOverride ?? (typeof part["text"] === "string" ? part["text"] : "");
    return text ? { type: "assistant", text, ...base } : null;
  }
  if (type === "reasoning") {
    const text = textOverride ?? (typeof part["text"] === "string" ? part["text"] : "");
    return text ? { type: "thinking", text, ...base } : null;
  }
  if (type === "tool") {
    const state = rec(part["state"]);
    const status = state ? str(state["status"]) : null;
    const callId = str(part["callID"]);
    const name = str(part["tool"]) ?? "tool";
    if (status === "completed" || status === "error") {
      // OpenCode's ToolState carries the result in `output` on completion and the
      // message in `error` on failure (verified against the 1.3.x OpenAPI).
      const raw = status === "error" ? state?.["error"] : state?.["output"];
      const content = typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
      return {
        type: "tool_result",
        toolCallId: callId,
        toolName: name,
        content,
        isError: status === "error",
        exitCode: null,
        ...base,
      };
    }
    // pending / running → the tool_call announcement
    return {
      type: "tool_call",
      toolCallId: callId,
      name,
      input: state ? (state["input"] ?? null) : null,
      ...base,
    };
  }
  return null;
}
