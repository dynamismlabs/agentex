import type { StreamEvent } from "../../types.js";

export interface OpenCodeParsedResult {
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

export function parseOpenCodeJsonl(stdout: string): OpenCodeParsedResult {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let costUsd = 0;
  let hasUsage = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event["sessionID"], "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event["type"], "");

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
      usage.outputTokens += asNumber(tokens["output"], 0) + asNumber(tokens["reasoning"], 0);
      costUsd += asNumber(part["cost"], 0);
      hasUsage = true;
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event["part"]);
      const state = parseObject(part["state"]);
      if (asString(state["status"], "") === "error") {
        const text = asString(state["error"], "").trim();
        if (text) errors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = asString(event["message"] as string ?? event["error"] as string, "").trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    model: null,
    usage: hasUsage ? usage : null,
    costUsd: costUsd > 0 ? costUsd : null,
    summary: messages.join("\n\n").trim() || null,
    isError: errors.length > 0,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function parseOpenCodeStreamLine(line: string): StreamEvent | null {
  const event = parseJson(line);
  if (!event) return null;

  const type = asString(event["type"], "");
  const timestamp = new Date().toISOString();

  if (type === "text") {
    const part = parseObject(event["part"]);
    const text = asString(part["text"], "");
    if (text) return { type: "assistant", text, timestamp };
  }

  if (type === "tool_use") {
    const part = parseObject(event["part"]);
    const name = asString(part["name"], "");
    return { type: "tool_call", name, input: part["input"], timestamp };
  }

  if (type === "step_finish") {
    return {
      type: "result",
      text: "",
      cost: null,
      isError: false,
      timestamp,
    };
  }

  if (type === "error") {
    return {
      type: "result",
      text: asString(event["message"], ""),
      cost: null,
      isError: true,
      timestamp,
    };
  }

  return null;
}

const OPENCODE_UNKNOWN_SESSION_RE = /unknown\s+session|session\b.*\bnot\s+found|no session/i;

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  return OPENCODE_UNKNOWN_SESSION_RE.test(stdout) || OPENCODE_UNKNOWN_SESSION_RE.test(stderr);
}

const OPENCODE_AUTH_RE = /api[_ ]?key\s+(?:required|missing|not\s+set|invalid)|unauthorized|authentication.*required/i;

export function isOpenCodeAuthRequired(stdout: string, stderr: string): boolean {
  return OPENCODE_AUTH_RE.test(stdout) || OPENCODE_AUTH_RE.test(stderr);
}
