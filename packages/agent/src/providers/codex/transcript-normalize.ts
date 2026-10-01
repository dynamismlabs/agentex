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
 *   response_item / custom_tool_call             → tool_call
 *   response_item / custom_tool_call_output      → tool_result
 *   event_msg     / task_complete                → result (completed, or failed with `error`)
 *   event_msg     / turn_aborted                 → result (interrupted)
 *
 * Current Codex runs shell work through freeform tools: `exec` takes a script
 * and `apply_patch` takes a patch, so most tool activity in a current rollout
 * is a `custom_tool_call`. Its `input` is the raw string the model wrote.
 *
 * Everything else — `session_meta`, `turn_context`, `task_started`,
 * `token_count`, `agent_message`/`agent_reasoning` duplicates, the
 * `item_completed` mirrors of response items, inter-agent `agent_message`
 * items, user/developer messages, unwrapped legacy lines, unknown types —
 * yields `[]`.
 *
 * The on-disk vocabulary is Codex-internal and version-shifting, so every field
 * is read defensively and a weird line NEVER throws — it returns `[]`. Codex
 * emits no native per-line wire id. File readers attach a deterministic
 * synthetic `line.eventId`, which this normalizer preserves. Standalone line
 * parsing still produces a null event id.
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
    eventId: line.eventId,
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
      const phase = messagePhase(payload["phase"]);
      return [{
        type: "assistant",
        text: extractMessageText(payload["content"]) ?? "",
        ...(phase ? { phase } : {}),
        ...base,
      }];
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

    if (innerType === "custom_tool_call") {
      return [
        {
          type: "tool_call",
          toolCallId: str(payload["call_id"]) ?? str(payload["id"]),
          name: str(payload["name"]) ?? "custom_tool_call",
          input: typeof payload["input"] === "string" ? payload["input"] : null,
          ...base,
        },
      ];
    }

    if (innerType === "function_call_output" || innerType === "custom_tool_call_output") {
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
      // A turn that failed (for example a model the account cannot use) still
      // ends in task_complete, with `error` set and no agent message.
      const error = turnErrorMessage(payload["error"]);
      return [
        {
          type: "result",
          text: error ?? str(payload["last_agent_message"]) ?? "",
          costUsd: null,
          isError: error !== null,
          stopReason: null,
          terminalReason: error !== null ? "failed" : "completed",
          numTurns: null,
          durationMs: num(payload["duration_ms"]),
          ...base,
        },
      ];
    }

    if (innerType === "turn_aborted") {
      // Same shape as a live `turn/completed` with status "interrupted".
      return [
        {
          type: "result",
          text: "",
          costUsd: null,
          isError: false,
          stopReason: null,
          terminalReason: str(payload["reason"]) ?? "interrupted",
          numTurns: null,
          durationMs: num(payload["duration_ms"]),
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

/** Finite number or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `task_complete.error` is `{ message, codex_error_info }`. The message is
 * often the API's JSON error body, so prefer its inner `error.message`.
 */
function turnErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return str(error);
  if (typeof error !== "object" || error === null) return null;
  const message = str((error as Record<string, unknown>)["message"]);
  if (!message) return "Turn failed";
  try {
    const body = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    return str(body?.error?.message) ?? str(body?.message) ?? message;
  } catch {
    return message;
  }
}

function messagePhase(v: unknown): "commentary" | "final_answer" | undefined {
  return v === "commentary" || v === "final_answer" ? v : undefined;
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
 * Tool output is usually a string. Some versions wrap it as
 * `{ output: "...", metadata: {...} }`, and Codex 0.142+ also writes a list of
 * content parts (`input_text`, `input_image`). Extract the readable text, one
 * part per line, with images left in `raw`. Fall back to a JSON dump
 * so nothing is silently lost. Returns "" when unreadable
 * (`tool_result.content` is a required string).
 */
function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    let text = "";
    for (const part of output) {
      if (typeof part !== "object" || part === null) continue;
      const partText = (part as { text?: unknown }).text;
      if (typeof partText !== "string" || partText.length === 0) continue;
      text += text && !text.endsWith("\n") ? `\n${partText}` : partText;
    }
    return text;
  }
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
