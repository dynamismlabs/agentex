import type { StreamEvent } from "../../types.js";

export interface CodexParsedResult {
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  summary: string | null;
  isError: boolean;
  errorCode: string | null;
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

export function parseCodexJsonl(stdout: string): CodexParsedResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasUsage = false;
  let summary: string | null = null;
  let isError = false;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event["type"], "");

    if (type === "thread.started") {
      sessionId = asString(event["thread_id"], "") || sessionId;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event["item"]);
      if (asString(item["type"], "") === "agent_message") {
        // Direct text field (Codex 0.30+)
        const directText = asString(item["text"], "");
        if (directText) {
          summary = directText;
        } else {
          // Fallback: content array with output_text blocks
          const content = Array.isArray(item["content"]) ? item["content"] : [];
          for (const entry of content) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
            const block = entry as Record<string, unknown>;
            if (asString(block["type"], "") === "output_text") {
              const text = asString(block["text"], "");
              if (text) summary = text;
            }
          }
        }
      }
      continue;
    }

    if (type === "turn.completed") {
      const usage = parseObject(event["usage"]);
      const inputTokens = asNumber(usage["input_tokens"], 0);
      const outputTokens = asNumber(usage["output_tokens"], 0);
      if (inputTokens > 0 || outputTokens > 0) {
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        hasUsage = true;
      }
      model = asString(event["model"], "") || model;
      continue;
    }

    if (type === "turn.failed") {
      isError = true;
      errorMessage = asString(event["message"], "") || asString(event["error"], "") || null;
      continue;
    }

    if (type === "error") {
      isError = true;
      errorMessage = asString(event["message"], "") || null;
      continue;
    }
  }

  return {
    sessionId,
    model,
    usage: hasUsage ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : null,
    costUsd: null, // Codex JSONL doesn't report cost
    summary,
    isError,
    errorCode,
    errorMessage,
  };
}

export function parseCodexStreamLine(line: string): StreamEvent | null {
  const event = parseJson(line);
  if (!event) return null;

  const type = asString(event["type"], "");
  const timestamp = new Date().toISOString();

  if (type === "thread.started") {
    return {
      type: "system",
      subtype: "init",
      sessionId: asString(event["thread_id"], "") || null,
      model: null,
      timestamp,
    };
  }

  if (type === "item.started") {
    const item = parseObject(event["item"]);
    if (asString(item["type"], "") === "command_execution") {
      return {
        type: "tool_call",
        name: "command_execution",
        input: asString(item["command"], ""),
        timestamp,
      };
    }
  }

  if (type === "item.completed") {
    const item = parseObject(event["item"]);
    if (asString(item["type"], "") === "command_execution") {
      const exitCode = typeof item["exit_code"] === "number" ? item["exit_code"] : null;
      return {
        type: "tool_result",
        toolCallId: asString(item["id"], ""),
        content: asString(item["aggregated_output"], ""),
        isError: exitCode !== null && exitCode !== 0,
        timestamp,
      };
    }
    if (asString(item["type"], "") === "agent_message") {
      // Direct text field (Codex 0.30+)
      const directText = asString(item["text"], "");
      if (directText) {
        return { type: "assistant", text: directText, timestamp };
      }
      // Fallback: content array with output_text blocks
      const content = Array.isArray(item["content"]) ? item["content"] : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block["type"], "") === "output_text") {
          return { type: "assistant", text: asString(block["text"], ""), timestamp };
        }
      }
    }
  }

  if (type === "turn.completed") {
    return {
      type: "result",
      text: "",
      cost: null,
      isError: false,
      timestamp,
    };
  }

  if (type === "error" || type === "turn.failed") {
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

const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+codex_core::rollout::list:/i;

export function stripCodexRolloutNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !CODEX_ROLLOUT_NOISE_RE.test(trimmed);
    })
    .join("\n");
}

const CODEX_AUTH_RE = /OPENAI_API_KEY\s+is\s+not\s+set|unauthorized|authentication.*required|invalid.*api.*key/i;

export function isCodexAuthRequired(stdout: string, stderr: string): boolean {
  return CODEX_AUTH_RE.test(stdout) || CODEX_AUTH_RE.test(stderr);
}

const CODEX_UNKNOWN_SESSION_RE = /unknown.*session|session.*not.*found|thread.*not.*found/i;

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  return CODEX_UNKNOWN_SESSION_RE.test(stdout) || CODEX_UNKNOWN_SESSION_RE.test(stderr);
}
