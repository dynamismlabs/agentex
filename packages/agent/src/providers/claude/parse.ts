import type { StreamEvent } from "../../types.js";

export interface ClaudeParsedResult {
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  costUsd: number | null;
  summary: string | null;
  isError: boolean;
  errorCode: string | null;
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

export function parseClaudeStreamJson(stdout: string): ClaudeParsedResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event["type"], "");

    if (type === "system" && asString(event["subtype"], "") === "init") {
      sessionId = asString(event["session_id"], "") || sessionId;
      model = asString(event["model"], "") || model;
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event["session_id"], "") || sessionId;
      const message = parseObject(event["message"]);
      const content = Array.isArray(message["content"]) ? message["content"] : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block["type"], "") === "text") {
          const text = asString(block["text"], "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event["session_id"], "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null,
      usage: null,
      summary: assistantTexts.join("\n\n").trim() || null,
      isError: false,
      errorCode: null,
    };
  }

  const usageObj = parseObject(finalResult["usage"]);
  const usage = {
    inputTokens: asNumber(usageObj["input_tokens"], 0),
    outputTokens: asNumber(usageObj["output_tokens"], 0),
    cachedInputTokens: asNumber(usageObj["cache_read_input_tokens"], 0),
  };

  const costRaw = finalResult["total_cost_usd"];
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult["result"], assistantTexts.join("\n\n")).trim() || null;
  const isError = finalResult["is_error"] === true;

  let errorCode: string | null = null;
  if (isClaudeMaxTurns(stdout)) {
    errorCode = "max_turns";
  }

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    isError,
    errorCode,
  };
}

export function toStreamEvents(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event["type"], "");
    const timestamp = new Date().toISOString();

    if (type === "system" && asString(event["subtype"], "") === "init") {
      events.push({
        type: "system",
        subtype: "init",
        sessionId: asString(event["session_id"], "") || null,
        model: asString(event["model"], "") || null,
        timestamp,
      });
    } else if (type === "assistant") {
      const message = parseObject(event["message"]);
      const content = Array.isArray(message["content"]) ? message["content"] : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        const blockType = asString(block["type"], "");
        if (blockType === "text") {
          events.push({ type: "assistant", text: asString(block["text"], ""), timestamp });
        } else if (blockType === "thinking") {
          events.push({ type: "thinking", text: asString(block["thinking"], ""), timestamp });
        } else if (blockType === "tool_use") {
          events.push({
            type: "tool_call",
            callId: asString(block["id"], "") || undefined,
            name: asString(block["name"], ""),
            input: block["input"],
            timestamp,
          });
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
    } else if (type === "result") {
      events.push({
        type: "result",
        text: asString(event["result"], ""),
        cost: typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : null,
        isError: event["is_error"] === true,
        timestamp,
      });
    }
  }
  return events;
}

export function parseStreamLine(line: string): StreamEvent[] {
  const event = parseJson(line);
  if (!event) return [];

  const type = asString(event["type"], "");
  const timestamp = new Date().toISOString();

  if (type === "system" && asString(event["subtype"], "") === "init") {
    return [{
      type: "system",
      subtype: "init",
      sessionId: asString(event["session_id"], "") || null,
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
      } else if (blockType === "thinking") {
        events.push({ type: "thinking", text: asString(block["thinking"], ""), timestamp });
      } else if (blockType === "tool_use") {
        events.push({ type: "tool_call", callId: asString(block["id"], "") || undefined, name: asString(block["name"], ""), input: block["input"], timestamp });
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

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const CLAUDE_UNKNOWN_SESSION_RE = /no conversation found with session id|unknown session|session .* not found/i;

export function isClaudeUnknownSessionError(stdout: string, stderr: string): boolean {
  return CLAUDE_UNKNOWN_SESSION_RE.test(stdout) || CLAUDE_UNKNOWN_SESSION_RE.test(stderr);
}

export function isClaudeAuthRequired(stdout: string, stderr: string): boolean {
  return CLAUDE_AUTH_REQUIRED_RE.test(stdout) || CLAUDE_AUTH_REQUIRED_RE.test(stderr);
}

export function isClaudeMaxTurns(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event["type"], "") === "result") {
      const subtype = asString(event["subtype"], "").toLowerCase();
      if (subtype === "error_max_turns") return true;
      const stopReason = asString(event["stop_reason"], "").toLowerCase();
      if (stopReason === "max_turns") return true;
    }
  }
  return false;
}
