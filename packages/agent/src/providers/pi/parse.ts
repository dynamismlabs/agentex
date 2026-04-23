import type { BaseStreamEventFields, StreamEvent } from "../../types.js";

const PROVIDER_TYPE = "pi";

function stubBase(event: Record<string, unknown>): BaseStreamEventFields {
  return {
    timestamp: new Date().toISOString(),
    providerType: PROVIDER_TYPE,
    sessionId: null,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: event,
  };
}

export interface PiParsedResult {
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number } | null;
  summary: string | null;
  isError: boolean;
  errorMessage: string | null;
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Skip malformed lines
  }
  return null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((c) => c["type"] === "text" && c["text"])
    .map((c) => c["text"] as string)
    .join("");
}

export function parsePiJsonl(stdout: string): PiParsedResult {
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  let hasUsage = false;
  let finalMessage: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event["type"], "");

    // Skip RPC protocol internals
    if (eventType === "response" || eventType === "extension_ui_request" || eventType === "extension_ui_response" || eventType === "extension_error") {
      continue;
    }

    if (eventType === "agent_end") {
      const agentMessages = event["messages"] as Array<Record<string, unknown>> | undefined;
      if (agentMessages && agentMessages.length > 0) {
        const lastMessage = agentMessages[agentMessages.length - 1];
        if (lastMessage?.["role"] === "assistant") {
          finalMessage = extractTextContent(lastMessage["content"]);
        }
      }
      continue;
    }

    if (eventType === "turn_end") {
      const message = asRecord(event["message"]);
      if (message) {
        const text = extractTextContent(message["content"]);
        if (text) {
          finalMessage = text;
          messages.push(text);
        }

        const usageObj = asRecord(message["usage"]);
        if (usageObj) {
          usage.inputTokens += asNumber(usageObj["input"], 0);
          usage.outputTokens += asNumber(usageObj["output"], 0);
          usage.cachedInputTokens += asNumber(usageObj["cacheRead"], 0);
          hasUsage = true;

          const cost = asRecord(usageObj["cost"]);
          if (cost) {
            usage.costUsd += asNumber(cost["total"], 0);
          }
        }
      }
      continue;
    }

    if (eventType === "message_update") {
      const assistantEvent = asRecord(event["assistantMessageEvent"]);
      if (assistantEvent) {
        const msgType = asString(assistantEvent["type"], "");
        if (msgType === "text_delta") {
          const delta = asString(assistantEvent["delta"], "");
          if (delta) {
            if (messages.length === 0) {
              messages.push(delta);
            } else {
              messages[messages.length - 1] += delta;
            }
          }
        }
      }
      continue;
    }

    if (eventType === "usage" || event["usage"]) {
      const usageObj = asRecord(event["usage"]);
      if (usageObj) {
        usage.inputTokens += asNumber(usageObj["inputTokens"] ?? usageObj["input"], 0);
        usage.outputTokens += asNumber(usageObj["outputTokens"] ?? usageObj["output"], 0);
        usage.cachedInputTokens += asNumber(usageObj["cachedInputTokens"] ?? usageObj["cacheRead"], 0);
        hasUsage = true;

        const cost = asRecord(usageObj["cost"]);
        if (cost) {
          usage.costUsd += asNumber(cost["total"] ?? usageObj["costUsd"], 0);
        } else {
          usage.costUsd += asNumber(usageObj["costUsd"], 0);
        }
      }
    }

    if (eventType === "error") {
      const text = asString(event["message"] as string ?? event["error"] as string, "").trim();
      if (text) errors.push(text);
    }
  }

  const summary = finalMessage ?? (messages.join("\n\n").trim() || null);

  return {
    sessionId: null, // Pi uses file-based sessions, not server-returned IDs
    model: null,
    usage: hasUsage ? usage : null,
    summary,
    isError: errors.length > 0,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function parsePiStreamLine(line: string): StreamEvent | null {
  const event = parseJson(line);
  if (!event) return null;

  const eventType = asString(event["type"], "");
  const base = stubBase(event);

  if (eventType === "message_update") {
    const assistantEvent = asRecord(event["assistantMessageEvent"]);
    if (assistantEvent && asString(assistantEvent["type"], "") === "text_delta") {
      const delta = asString(assistantEvent["delta"], "");
      if (delta) return { type: "assistant", text: delta, ...base };
    }
  }

  if (eventType === "tool_execution_start") {
    return {
      type: "tool_call",
      toolCallId: asString(event["toolCallId"], "") || null,
      name: asString(event["toolName"], ""),
      input: event["args"],
      ...base,
    };
  }

  if (eventType === "tool_execution_end") {
    const result = event["result"];
    return {
      type: "tool_result",
      toolCallId: asString(event["toolCallId"], "") || null,
      content: typeof result === "string" ? result : JSON.stringify(result),
      isError: event["isError"] === true,
      exitCode: null,
      ...base,
    };
  }

  if (eventType === "agent_end") {
    return {
      type: "result",
      text: "",
      costUsd: null,
      isError: false,
      stopReason: null,
      terminalReason: null,
      numTurns: null,
      durationMs: null,
      ...base,
    };
  }

  // Forward-compat: surface unknown wire events rather than dropping them.
  return { type: "unknown", subtype: eventType, ...base };
}

const PI_UNKNOWN_SESSION_RE = /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i;

export function isPiUnknownSessionError(stdout: string, stderr: string): boolean {
  return PI_UNKNOWN_SESSION_RE.test(stdout) || PI_UNKNOWN_SESSION_RE.test(stderr);
}
