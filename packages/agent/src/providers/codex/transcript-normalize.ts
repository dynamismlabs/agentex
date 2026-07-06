import type { BaseStreamEventFields, StreamEvent } from "../../types.js";
import type { CodexTranscriptLine } from "./transcript.js";

/**
 * Normalize a Codex on-disk transcript line into `StreamEvent`s — the library
 * absorption of Flow's `codex-on-disk.ts` map/drop table, so `catchUp` replay
 * yields the same event vocabulary as a live `onEvent` stream.
 *
 * Coverage (wrapped ≥0.10 rollout format; `line.payload` present):
 *
 *   response_item / message (role="assistant")  → assistant
 *   response_item / reasoning                    → thinking
 *   response_item / function_call                → tool_call
 *   response_item / function_call_output         → tool_result
 *   event_msg     / task_complete                → result (completed)
 *
 * Everything else — `session_meta`, `turn_context`, `task_started`,
 * `token_count`, `agent_message`/`agent_reasoning` duplicates, user/developer
 * messages, unwrapped legacy lines, unknown types — yields `[]`.
 *
 * The on-disk vocabulary is Codex-internal and version-shifting, so every field
 * is read defensively and a weird line NEVER throws — it returns `[]`. Codex
 * emits no per-line wire id, so `eventId`/`turnId` are null (hosts gate replay
 * dedup on their own "not currently running" flag; see spec §9.7).
 */
export function codexLineToStreamEvents(
  line: CodexTranscriptLine,
  ctx: { sessionId: string | null },
): StreamEvent[] {
  try {
    return mapLine(line, ctx.sessionId);
  } catch {
    // Guardrail §9.5: never throw on a weird line.
    return [];
  }
}

function mapLine(line: CodexTranscriptLine, sessionId: string | null): StreamEvent[] {
  const payload = line.payload;
  // Flow's authoritative mapping only handles the wrapped format (payload
  // present). Unwrapped legacy lines carry no reliable surface here → drop.
  if (!payload) return [];

  const base: BaseStreamEventFields = {
    // "timestamp from the line or epoch-null fallback" (spec §5.4).
    timestamp: line.timestamp ?? new Date(0).toISOString(),
    providerType: "codex",
    sessionId,
    messageId: null,
    eventId: null,
    turnId: null,
    parentToolCallId: null,
    raw: line.raw,
  };

  const innerType = typeof payload["type"] === "string" ? (payload["type"] as string) : null;

  if (line.type === "response_item") {
    if (innerType === "message") {
      // Only assistant messages surface; developer/user messages are
      // system-prompt material we don't replay.
      if (payload["role"] !== "assistant") return [];
      return [{ type: "assistant", text: extractMessageText(payload["content"]) ?? "", ...base }];
    }

    if (innerType === "reasoning") {
      // Reasoning content may be empty / encrypted out-of-band; we still emit a
      // `thinking` event (matching the live parser) — text is "" when the
      // summary carries none.
      return [{ type: "thinking", text: extractReasoningSummary(payload["summary"]) ?? "", ...base }];
    }

    if (innerType === "function_call") {
      return [
        {
          type: "tool_call",
          toolCallId: str(payload["call_id"]) ?? str(payload["id"]),
          name: str(payload["name"]) ?? "function_call",
          input: parseToolArguments(payload["arguments"]) ?? str(payload["arguments"]) ?? null,
          ...base,
        },
      ];
    }

    if (innerType === "function_call_output") {
      return [
        {
          type: "tool_result",
          toolCallId: str(payload["call_id"]),
          // On-disk output carries no reliable name/error/exit signal; hosts
          // correlate the name via the paired tool_call's call_id.
          toolName: null,
          content: extractOutputText(payload["output"]),
          isError: false,
          exitCode: null,
          ...base,
        },
      ];
    }

    return [];
  }

  if (line.type === "event_msg") {
    if (innerType === "task_complete") {
      return [
        {
          type: "result",
          text: str(payload["last_agent_message"]) ?? "",
          costUsd: null,
          isError: false,
          stopReason: null,
          terminalReason: "completed",
          numTurns: null,
          durationMs: null,
          ...base,
        },
      ];
    }
    return [];
  }

  return [];
}

/** Non-empty string or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * `response_item/message.content` is an array of typed parts (`output_text`
 * for assistant replies). Concat the text parts with a blank-line separator.
 */
function extractMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as { text?: unknown };
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * `response_item/reasoning.summary` is an array of `{type:"summary_text",
 * text}` blocks; `content` is usually null and `encrypted_content` opaque, so
 * the summary is the only readable representation.
 */
function extractReasoningSummary(summary: unknown): string | null {
  if (!Array.isArray(summary)) return null;
  const parts: string[] = [];
  for (const entry of summary) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as { text?: unknown };
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * `function_call_output.output` is usually a string, but some versions wrap it
 * as `{ output: "...", metadata: {...} }`. Extract the readable text; fall back
 * to a JSON dump so nothing is silently lost. Returns "" when unreadable
 * (`tool_result.content` is a required string).
 */
function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const inner = (output as Record<string, unknown>)["output"];
    if (typeof inner === "string") return inner;
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * `function_call.arguments` is a JSON-encoded string (OpenAI function-call wire
 * format). Parse to an object; tolerate malformed input (return null so the
 * caller falls back to the raw string).
 */
function parseToolArguments(args: unknown): Record<string, unknown> | null {
  if (typeof args !== "string" || args.length === 0) return null;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
