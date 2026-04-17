import type { StreamEvent } from "../../types.js";

export interface GeminiParsedResult {
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
    asString(event["checkpoint_id"], "").trim() ||
    asString(event["thread_id"], "").trim() ||
    null
  );
}

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record["text"], "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record["content"]) ? record["content"] : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part["type"], "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part["text"], "").trim() || asString(part["content"], "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage["usageMetadata"]);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  target.inputTokens += asNumber(
    source["input_tokens"],
    asNumber(source["inputTokens"], asNumber(source["promptTokenCount"], 0)),
  );
  target.cachedInputTokens += asNumber(
    source["cached_input_tokens"],
    asNumber(source["cachedInputTokens"], asNumber(source["cachedContentTokenCount"], 0)),
  );
  target.outputTokens += asNumber(
    source["output_tokens"],
    asNumber(source["outputTokens"], asNumber(source["candidatesTokenCount"], 0)),
  );
}

export function parseGeminiJsonl(stdout: string): GeminiParsedResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let hasUsage = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event["type"], "").trim();

    if (type === "system" && asString(event["subtype"], "").trim() === "init") {
      model = asString(event["model"], "").trim() || model;
      continue;
    }

    if (type === "assistant") {
      messages.push(...collectMessageText(event["message"]));
      continue;
    }

    if (type === "result") {
      accumulateUsage(usage, event["usage"] ?? event["usageMetadata"]);
      hasUsage = true;
      const resultText = asString(event["result"], "").trim() || asString(event["text"], "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      costUsd = asNumber(event["total_cost_usd"], asNumber(event["cost_usd"], asNumber(event["cost"], costUsd ?? 0))) || costUsd;
      model = asString(event["model"], "").trim() || model;
      const isError = event["is_error"] === true || asString(event["subtype"], "").toLowerCase() === "error";
      if (isError) {
        const text = asString(event["error"] as string ?? event["message"] as string ?? event["result"] as string, "").trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asString(event["message"] as string ?? event["error"] as string, "").trim();
      if (text) errorMessage = text;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event["subtype"], "").trim().toLowerCase();
      if (subtype === "error") {
        const text = asString(event["message"] as string ?? event["error"] as string, "").trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event["part"]);
      const text = asString(part["text"], "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish" || event["usage"] || event["usageMetadata"]) {
      accumulateUsage(usage, event["usage"] ?? event["usageMetadata"]);
      hasUsage = true;
      costUsd = asNumber(event["total_cost_usd"], asNumber(event["cost_usd"], asNumber(event["cost"], costUsd ?? 0))) || costUsd;
      continue;
    }
  }

  return {
    sessionId,
    model,
    costUsd,
    usage: hasUsage ? usage : null,
    summary: messages.join("\n\n").trim() || null,
    isError: errorMessage !== null,
    errorMessage,
  };
}

export function parseGeminiStreamLine(line: string): StreamEvent[] {
  const event = parseJson(line);
  if (!event) return [];

  const type = asString(event["type"], "").trim();
  const timestamp = new Date().toISOString();

  if (type === "system" && asString(event["subtype"], "").trim() === "init") {
    return [{
      type: "system",
      subtype: "init",
      sessionId: readSessionId(event),
      model: asString(event["model"], "") || null,
      timestamp,
    }];
  }

  if (type === "assistant") {
    const events: StreamEvent[] = [];
    const message = parseObject(event["message"]);
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      const blockType = asString(block["type"], "");
      if (blockType === "text") {
        events.push({ type: "assistant", text: asString(block["text"], ""), timestamp });
      } else if (blockType === "tool_use") {
        events.push({ type: "tool_call", callId: asString(block["id"], "") || asString(block["tool_use_id"], "") || undefined, name: asString(block["name"], ""), input: block["input"], timestamp });
      } else if (blockType === "tool_result") {
        events.push({
          type: "tool_result",
          toolCallId: asString(block["tool_use_id"], ""),
          content: asString(block["content"], ""),
          isError: block["is_error"] === true,
          timestamp,
        });
      }
    }
    return events;
  }

  if (type === "result") {
    return [{
      type: "result",
      text: asString(event["result"], ""),
      cost: typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : null,
      isError: event["is_error"] === true,
      timestamp,
    }];
  }

  return [];
}

const GEMINI_AUTH_RE = /(?:not\s+authenticated|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|not\s+logged\s+in|run\s+`?gemini\s+auth)/i;
const GEMINI_UNKNOWN_SESSION_RE = /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume/i;

export function isGeminiUnknownSessionError(stdout: string, stderr: string): boolean {
  return GEMINI_UNKNOWN_SESSION_RE.test(stdout) || GEMINI_UNKNOWN_SESSION_RE.test(stderr);
}

export function isGeminiAuthRequired(stdout: string, stderr: string): boolean {
  return GEMINI_AUTH_RE.test(stdout) || GEMINI_AUTH_RE.test(stderr);
}

export function isGeminiTurnLimit(exitCode: number | null): boolean {
  return exitCode === 53;
}
