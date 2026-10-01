import type { BaseStreamEventFields, ExecutionStatus, StreamEvent, TokenUsage, TurnResult } from "../../types.js";

/**
 * Parser for Antigravity CLI (`agy`) headless `stream-json` output.
 *
 * Wire contract (https://antigravity.google/docs/cli/headless): one `init`
 * event per process, `step_update` events while a turn runs, and one `result`
 * event per turn. Every line is `{ "event": <name>, <name>: { ... } }`.
 *
 * - `step_update.step_type` is a closed vocabulary; observed values are
 *   `user_input`, `agent_response`, `tool`, and `checkpoint`. A step is
 *   `ACTIVE` while it runs and `DONE` when it finishes. `agent_response`
 *   streams its text as `text_delta` fragments across ACTIVE updates and a
 *   final DONE (short replies arrive as a single DONE).
 * - `result.usage`, `num_turns`, and `duration_seconds` are cumulative over
 *   the process's session; `response` covers only the turn that emitted it.
 *   The parser turns the cumulative counters back into per-turn deltas.
 *
 * The parser is stateful (text accumulates per step, usage is differenced
 * per turn), so use one instance per `agy` process.
 */

export const ANTIGRAVITY_PROVIDER_TYPE = "antigravity";

/** Token counters as `agy` reports them. `output` includes `thinking`. */
export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

/** A parsed `result` event, with per-turn deltas alongside the raw totals. */
export interface AgyResult {
  /** `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, or `RUNNING`. */
  status: string;
  /** Response text for the turn that emitted this result. */
  response: string;
  error: string | null;
  conversationId: string | null;
  /** Cumulative over the process's session. */
  numTurns: number | null;
  /** This turn's share of the cumulative `duration_seconds`, in ms. */
  turnDurationMs: number | null;
  /** Cumulative over the process's session. */
  usage: AgyUsage | null;
  /** This turn's share of the cumulative usage. */
  turnUsage: AgyUsage | null;
  /** Tools the CLI soft-denied because no permission rule allowed them. */
  deniedActions: unknown[] | null;
  structuredOutput: unknown;
  raw: Record<string, unknown>;
}

/** `AGY_ERROR: {...}` stderr line printed when a turn fails on an agent or model API error. */
export interface AgyErrorReport {
  message: string | null;
  status: string | null;
  code: number | string | null;
  retryable: boolean | null;
  raw: Record<string, unknown>;
}

export interface AgyStreamParserOptions {
  /** Emit `assistant_delta` / `thinking_delta` events for streamed fragments. */
  includePartialMessages?: boolean;
  /** Conversation id already known (resume), used until the stream reports one. */
  conversationId?: string | null;
}

export interface AgyParsedLine {
  events: StreamEvent[];
  result: AgyResult | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return rec(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function parseAgyUsage(value: unknown): AgyUsage | null {
  const u = rec(value);
  if (!u) return null;
  const inputTokens = num(u["input_tokens"]) ?? 0;
  const outputTokens = num(u["output_tokens"]) ?? 0;
  return {
    inputTokens,
    outputTokens,
    thinkingTokens: num(u["thinking_tokens"]) ?? 0,
    cacheReadTokens: num(u["cache_read_tokens"]) ?? 0,
    totalTokens: num(u["total_tokens"]) ?? inputTokens + outputTokens,
  };
}

function subtractUsage(total: AgyUsage, previous: AgyUsage | null): AgyUsage {
  if (!previous) return total;
  const diff = (a: number, b: number) => Math.max(0, a - b);
  return {
    inputTokens: diff(total.inputTokens, previous.inputTokens),
    outputTokens: diff(total.outputTokens, previous.outputTokens),
    thinkingTokens: diff(total.thinkingTokens, previous.thinkingTokens),
    cacheReadTokens: diff(total.cacheReadTokens, previous.cacheReadTokens),
    totalTokens: diff(total.totalTokens, previous.totalTokens),
  };
}

/**
 * Map `agy` token counters onto agentex `TokenUsage`. `input_tokens` already
 * includes cache reads (like Codex), and `output_tokens` already includes
 * thinking, so the counters pass through without re-adding anything.
 */
export function agyUsageToTokenUsage(usage: AgyUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
  };
}

/** Key a usage record by model. `agy` reports the model only when one was pinned. */
export function agyUsageRecord(usage: AgyUsage | null, model: string | null): Record<string, TokenUsage> | undefined {
  if (!usage) return undefined;
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheReadTokens === 0) return undefined;
  return { [model ?? "default"]: agyUsageToTokenUsage(usage) };
}

function stringifyOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class AgyStreamParser {
  conversationId: string | null;
  model: string | null = null;
  permissionMode: string | null = null;

  private readonly includePartial: boolean;
  private readonly responseText = new Map<number, string>();
  private readonly thinkingText = new Map<number, string>();
  private readonly toolCallsOpened = new Set<number>();
  private previousUsage: AgyUsage | null = null;
  private previousDurationSec = 0;

  constructor(options: AgyStreamParserOptions = {}) {
    this.includePartial = options.includePartialMessages === true;
    this.conversationId = options.conversationId ?? null;
  }

  parseLine(line: string): AgyParsedLine {
    const event = parseJsonObject(line);
    if (!event) return { events: [], result: null };
    const kind = str(event["event"]);
    switch (kind) {
      case "init":
        return { events: this.onInit(event), result: null };
      case "step_update":
        return { events: this.onStep(event), result: null };
      case "result":
        return this.onResult(event);
      default:
        return {
          events: [{ type: "unknown", subtype: kind ?? "unknown", ...this.base(event) }],
          result: null,
        };
    }
  }

  private noteConversation(id: unknown): void {
    const value = str(id);
    if (value) this.conversationId = value;
  }

  private base(raw: Record<string, unknown>, messageId: string | null = null): BaseStreamEventFields {
    return {
      timestamp: new Date().toISOString(),
      providerType: ANTIGRAVITY_PROVIDER_TYPE,
      sessionId: this.conversationId,
      messageId,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw,
    };
  }

  private onInit(event: Record<string, unknown>): StreamEvent[] {
    const init = rec(event["init"]) ?? {};
    this.noteConversation(event["conversation_id"] ?? init["conversation_id"]);
    this.model = str(init["model"]) ?? this.model;
    this.permissionMode = str(init["permission_mode"]) ?? this.permissionMode;
    const tools = Array.isArray(init["tools"])
      ? (init["tools"] as unknown[]).filter((t): t is string => typeof t === "string")
      : null;
    return [{
      type: "system",
      subtype: "init",
      model: this.model,
      cwd: str(init["cwd"]),
      tools,
      permissionMode: this.permissionMode,
      ...this.base(event),
    }];
  }

  private onStep(event: Record<string, unknown>): StreamEvent[] {
    const step = rec(event["step_update"]);
    if (!step) return [];
    this.noteConversation(step["conversation_id"]);
    const index = num(step["step_index"]) ?? -1;
    const state = str(step["state"]);
    const done = state !== "ACTIVE";
    const stepId = `${this.conversationId ?? "agy"}:${index}`;
    const type = str(step["step_type"]);

    // Thinking is not part of the documented stream, but the step schema has
    // room for it; surface it if a build sends it rather than dropping it.
    const events = this.onThinking(step, event, index, stepId, done);

    if (type === "user_input" || type === "checkpoint") return events;

    if (type === "agent_response") {
      const delta = typeof step["text_delta"] === "string" ? step["text_delta"] as string : "";
      const text = (this.responseText.get(index) ?? "") + delta;
      this.responseText.set(index, text);
      if (delta && this.includePartial) {
        events.push({ type: "assistant_delta", text: delta, blockIndex: 0, ...this.base(event, stepId) });
      }
      if (done) {
        this.responseText.delete(index);
        if (text.trim()) events.push({ type: "assistant", text, ...this.base(event, stepId) });
      }
      return events;
    }

    const toolInfo = rec(step["tool_info"]);
    const subagentInfo = rec(step["subagent_info"]);
    if (type === "tool" || toolInfo || subagentInfo) {
      const name = str(step["tool_name"]) ?? str(toolInfo?.["name"]) ?? (subagentInfo ? "subagent" : "tool");
      if (!this.toolCallsOpened.has(index)) {
        this.toolCallsOpened.add(index);
        events.push({
          type: "tool_call",
          toolCallId: stepId,
          name,
          input: toolInfo?.["parameters"] ?? subagentInfo ?? null,
          ...this.base(event, stepId),
        });
      }
      if (done) {
        this.toolCallsOpened.delete(index);
        const error = rec(toolInfo?.["error"]);
        const output = stringifyOutput(toolInfo?.["output"] ?? (subagentInfo ? subagentInfo : null));
        events.push({
          type: "tool_result",
          toolCallId: stepId,
          toolName: name,
          content: output || str(error?.["message"]) || "",
          isError: error !== null,
          exitCode: null,
          ...this.base(event, stepId),
        });
      }
      return events;
    }

    // Forward-compat: a step type this parser does not model yet.
    if (done) events.push({ type: "unknown", subtype: type ?? "step_update", ...this.base(event, stepId) });
    return events;
  }

  private onThinking(
    step: Record<string, unknown>,
    event: Record<string, unknown>,
    index: number,
    stepId: string,
    done: boolean,
  ): StreamEvent[] {
    const delta = typeof step["thinking_delta"] === "string" ? step["thinking_delta"] as string : "";
    if (!delta && !this.thinkingText.has(index)) return [];
    const events: StreamEvent[] = [];
    const text = (this.thinkingText.get(index) ?? "") + delta;
    this.thinkingText.set(index, text);
    if (delta && this.includePartial) {
      events.push({ type: "thinking_delta", text: delta, blockIndex: 0, ...this.base(event, stepId) });
    }
    if (done) {
      this.thinkingText.delete(index);
      if (text.trim()) events.push({ type: "thinking", text, ...this.base(event, stepId) });
    }
    return events;
  }

  private onResult(event: Record<string, unknown>): AgyParsedLine {
    const payload = rec(event["result"]) ?? {};
    this.noteConversation(payload["conversation_id"]);
    const status = str(payload["status"]) ?? "ERROR";
    const usage = parseAgyUsage(payload["usage"]);
    const turnUsage = usage ? subtractUsage(usage, this.previousUsage) : null;
    if (usage) this.previousUsage = usage;
    const durationSec = num(payload["duration_seconds"]);
    const turnDurationMs = durationSec == null
      ? null
      : Math.round(Math.max(0, durationSec - this.previousDurationSec) * 1000);
    if (durationSec != null) this.previousDurationSec = durationSec;
    // Steps of a finished turn never complete; don't leak them into the next.
    this.responseText.clear();
    this.thinkingText.clear();
    this.toolCallsOpened.clear();

    const result: AgyResult = {
      status,
      response: typeof payload["response"] === "string" ? payload["response"] as string : "",
      error: str(payload["error"]),
      conversationId: this.conversationId,
      numTurns: num(payload["num_turns"]),
      turnDurationMs,
      usage,
      turnUsage,
      deniedActions: Array.isArray(payload["denied_actions"]) ? payload["denied_actions"] as unknown[] : null,
      structuredOutput: payload["structured_output"],
      raw: event,
    };
    return {
      events: [{
        type: "result",
        text: result.response,
        costUsd: null,
        isError: status !== "SUCCESS",
        stopReason: null,
        terminalReason: status.toLowerCase(),
        numTurns: result.numTurns,
        durationMs: turnDurationMs,
        ...this.base(event),
      }],
      result,
    };
  }
}

/** Parse a complete `stream-json` transcript. Returns every turn's result in order. */
export function parseAgyStreamJson(stdout: string, options?: AgyStreamParserOptions): {
  events: StreamEvent[];
  results: AgyResult[];
  conversationId: string | null;
  model: string | null;
} {
  const parser = new AgyStreamParser(options);
  const events: StreamEvent[] = [];
  const results: AgyResult[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parser.parseLine(line);
    events.push(...parsed.events);
    if (parsed.result) results.push(parsed.result);
  }
  return { events, results, conversationId: parser.conversationId, model: parser.model };
}

/** Parse an `AGY_ERROR: {...}` stderr line, or return null for any other line. */
export function parseAgyErrorLine(line: string): AgyErrorReport | null {
  const match = line.match(/AGY_ERROR:\s*(\{.*\})\s*$/);
  if (!match?.[1]) return null;
  const raw = parseJsonObject(match[1]);
  if (!raw) return null;
  const code = raw["code"] ?? raw["http_code"] ?? raw["grpc_code"] ?? raw["status_code"] ?? null;
  return {
    message: str(raw["message"]) ?? str(raw["error"]),
    status: str(raw["status"]) ?? str(raw["canonical_status"]) ?? str(raw["canonicalStatus"]),
    code: typeof code === "number" || typeof code === "string" ? code : null,
    retryable: typeof raw["retryable"] === "boolean" ? raw["retryable"] as boolean : null,
    raw,
  };
}

const AGY_AUTH_PROMPT_RE = /Authentication required|Please (?:visit the URL to log in|sign in)|authentication failed or timed out|not signed in|Failed to sign in/i;

/** True when `agy` output says the CLI has no usable sign-in. */
export function isAgyAuthRequired(text: string): boolean {
  return AGY_AUTH_PROMPT_RE.test(text);
}

const RATE_LIMIT_RE = /RESOURCE_EXHAUSTED|rate.?limit|quota|\b429\b/i;

/** Error code for a failed turn, from the most specific signal available. */
export function classifyAgyFailure(result: AgyResult | null, agyError: AgyErrorReport | null): string {
  const text = [result?.error, agyError?.message, agyError?.status, agyError?.code].filter(Boolean).join(" ");
  if (isAgyAuthRequired(text) || /UNAUTHENTICATED|PERMISSION_DENIED|\b401\b/.test(text)) return "auth_required";
  if (RATE_LIMIT_RE.test(text)) return "rate_limited";
  if (/invalid model selection|not recognized as a known model/i.test(text)) return "invalid_model";
  if (result?.status === "WAITING") return "waiting_for_input";
  if (result?.status === "INVALID") return "invalid_state";
  if (result?.status === "RUNNING") return "incomplete_turn";
  return "agent_error";
}

/** Map an `agy` result status onto a one-shot `ExecutionStatus`. */
export function mapAgyExecutionStatus(status: string): ExecutionStatus {
  switch (status) {
    case "SUCCESS":
      return "completed";
    case "CANCELED":
    case "INTERRUPTED":
      return "aborted";
    case "WAITING":
      return "blocked";
    default:
      return "failed";
  }
}

/** Map an `agy` result status onto a session `TurnResult` status. */
export function mapAgyTurnStatus(status: string): TurnResult["status"] {
  const mapped = mapAgyExecutionStatus(status);
  return mapped === "blocked" ? "failed" : mapped;
}
