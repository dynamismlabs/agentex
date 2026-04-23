import type { BaseStreamEventFields, StreamEvent } from "../../types.js";

const PROVIDER_TYPE = "cursor";

function stubBase(event: Record<string, unknown>, sessionId: string | null = null): BaseStreamEventFields {
  return {
    timestamp: new Date().toISOString(),
    providerType: PROVIDER_TYPE,
    sessionId,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: event,
  };
}

export interface CursorParsedResult {
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  costUsd: number | null;
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

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event["session_id"], "").trim() ||
    asString(event["sessionId"], "").trim() ||
    asString(event["sessionID"], "").trim() ||
    null
  );
}

function collectAssistantText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const rec = parseObject(message);
  const direct = asString(rec["text"], "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(rec["content"]) ? rec["content"] : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part["type"], "").trim();
    if (type === "output_text" || type === "text") {
      const text = asString(part["text"], "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

/**
 * Normalize Cursor stream lines which may have a "stdout: {...}" or "stderr: {...}" prefix.
 */
export function normalizeCursorStreamLine(rawLine: string): {
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { stream: null, line: "" };

  const prefixed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*([\[{].*)$/i);
  if (!prefixed) {
    return { stream: null, line: trimmed };
  }

  const stream = prefixed[1]?.toLowerCase() === "stderr" ? "stderr" : "stdout";
  const line = (prefixed[2] ?? "").trim();
  return { stream, line };
}

export function parseCursorJsonl(stdout: string): CursorParsedResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let hasUsage = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = normalizeCursorStreamLine(rawLine).line;
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSession = readSessionId(event);
    if (foundSession) sessionId = foundSession;

    const type = asString(event["type"], "").trim();

    if (type === "system" && asString(event["subtype"], "").trim() === "init") {
      model = asString(event["model"], "").trim() || model;
      continue;
    }

    if (type === "assistant") {
      messages.push(...collectAssistantText(event["message"]));
      continue;
    }

    if (type === "result") {
      const usageObj = parseObject(event["usage"]);
      usage.inputTokens += asNumber(usageObj["input_tokens"], asNumber(usageObj["inputTokens"], 0));
      usage.cachedInputTokens += asNumber(usageObj["cached_input_tokens"], asNumber(usageObj["cachedInputTokens"], asNumber(usageObj["cache_read_input_tokens"], 0)));
      usage.outputTokens += asNumber(usageObj["output_tokens"], asNumber(usageObj["outputTokens"], 0));
      hasUsage = true;
      totalCostUsd += asNumber(event["total_cost_usd"], asNumber(event["cost_usd"], asNumber(event["cost"], 0)));
      model = asString(event["model"], "").trim() || model;

      const isError = event["is_error"] === true || asString(event["subtype"], "").toLowerCase() === "error";
      const resultText = asString(event["result"], "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      if (isError) {
        const text = asString(event["error"] as string ?? event["message"] as string ?? event["result"] as string, "").trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const msg = asString(event["message"] as string ?? event["error"] as string, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event["subtype"], "").trim().toLowerCase();
      if (subtype === "error") {
        const msg = asString(event["message"] as string ?? event["error"] as string, "").trim();
        if (msg) errorMessage = msg;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event["part"]);
      const text = asString(part["text"], "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event["part"]);
      const tokens = parseObject(part["tokens"]);
      const cache = parseObject(tokens["cache"]);
      usage.inputTokens += asNumber(tokens["input"], 0);
      usage.cachedInputTokens += asNumber(cache["read"], 0);
      usage.outputTokens += asNumber(tokens["output"], 0);
      hasUsage = true;
      totalCostUsd += asNumber(part["cost"], 0);
      continue;
    }
  }

  return {
    sessionId,
    model,
    usage: hasUsage ? usage : null,
    costUsd: totalCostUsd > 0 ? totalCostUsd : null,
    summary: messages.join("\n\n").trim() || null,
    isError: errorMessage !== null,
    errorMessage,
  };
}

export function parseCursorStreamLine(line: string): StreamEvent | null {
  const normalized = normalizeCursorStreamLine(line);
  if (!normalized.line) return null;

  const event = parseJson(normalized.line);
  if (!event) return null;

  const type = asString(event["type"], "").trim();
  const sessionId = readSessionId(event);
  const base = stubBase(event, sessionId);

  if (type === "system" && asString(event["subtype"], "").trim() === "init") {
    return {
      type: "system",
      subtype: "init",
      model: asString(event["model"], "") || null,
      cwd: null,
      tools: null,
      permissionMode: null,
      ...base,
    };
  }

  if (type === "assistant") {
    const message = parseObject(event["message"]);
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const partRaw of content) {
      const part = parseObject(partRaw);
      const blockType = asString(part["type"], "").trim();
      if (blockType === "tool_use") {
        return {
          type: "tool_call",
          toolCallId: asString(part["id"], "") || null,
          name: asString(part["name"], ""),
          input: part["input"],
          ...base,
        };
      }
      if (blockType === "tool_result") {
        return {
          type: "tool_result",
          toolCallId: asString(part["tool_use_id"], "") || null,
          content: asString(part["content"], ""),
          isError: part["is_error"] === true,
          exitCode: null,
          ...base,
        };
      }
    }

    const texts = collectAssistantText(event["message"]);
    if (texts.length > 0) {
      return { type: "assistant", text: texts.join("\n"), ...base };
    }
  }

  if (type === "result") {
    return {
      type: "result",
      text: asString(event["result"], ""),
      costUsd: typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : null,
      isError: event["is_error"] === true,
      stopReason: null,
      terminalReason: null,
      numTurns: null,
      durationMs: null,
      ...base,
    };
  }

  // Forward-compat: surface unknown wire events rather than dropping them.
  return { type: "unknown", subtype: type, ...base };
}

const CURSOR_UNKNOWN_SESSION_RE = /unknown\s+(session|chat)|session\s+.*\s+not\s+found|chat\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|could\s+not\s+resume/i;

export function isCursorUnknownSessionError(stdout: string, stderr: string): boolean {
  return CURSOR_UNKNOWN_SESSION_RE.test(stdout) || CURSOR_UNKNOWN_SESSION_RE.test(stderr);
}

const CURSOR_AUTH_RE = /CURSOR_API_KEY\s+is\s+not\s+set|OPENAI_API_KEY\s+is\s+not\s+set|unauthorized|authentication.*required/i;

export function isCursorAuthRequired(stdout: string, stderr: string): boolean {
  return CURSOR_AUTH_RE.test(stdout) || CURSOR_AUTH_RE.test(stderr);
}
