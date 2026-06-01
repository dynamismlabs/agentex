import type {
  AuthRequiredReason,
  BaseStreamEventFields,
  ModelUsage,
  RateLimitInfo,
  StreamEvent,
} from "../../types.js";

const PROVIDER_TYPE = "claude";

/** Shell command users run outside an interactive Claude session to
 * re-authenticate. Surfaced on `auth_required` events. The in-CLI slash
 * command is `/login`; this is the equivalent for hosts that are spawning
 * `claude` as a subprocess and need to prompt the user to log in
 * externally. */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

export interface ClaudeParsedResult {
  sessionId: string | null;
  model: string | null;
  /**
   * Per-model usage from Claude's `modelUsage` result payload (rich) or
   * synthesized from the final `result.usage` when `modelUsage` is absent.
   */
  modelUsage: Record<string, ModelUsage> | null;
  costUsd: number | null;
  summary: string | null;
  isError: boolean;
  errorCode: string | null;
  /** Populated when the final result event carries these fields. */
  stopReason: string | null;
  terminalReason: string | null;
  numTurns: number | null;
  durationApiMs: number | null;
  permissionDenials: unknown[] | null;
  rateLimits: RateLimitInfo[];
  /** The final `result` event verbatim, or null if none was seen. */
  finalEvent: Record<string, unknown> | null;
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

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function baseFieldsFromEvent(
  event: Record<string, unknown>,
  messageId: string | null,
): BaseStreamEventFields {
  return {
    timestamp: new Date().toISOString(),
    providerType: PROVIDER_TYPE,
    sessionId: asNullableString(event["session_id"]),
    messageId,
    eventId: asNullableString(event["uuid"]),
    turnId: null, // Claude doesn't model turns explicitly
    parentToolCallId: asNullableString(event["parent_tool_use_id"]),
    raw: event,
  };
}

function rateLimitFromEvent(event: Record<string, unknown>): RateLimitInfo | null {
  const info = parseObject(event["rate_limit_info"]);
  if (Object.keys(info).length === 0) return null;
  const resetsAt = info["resetsAt"];
  const overageResetsAt = info["overageResetsAt"];
  const resetEpoch =
    typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt :
    typeof overageResetsAt === "number" && Number.isFinite(overageResetsAt) ? overageResetsAt :
    null;
  return {
    status: asString(info["status"], "unknown"),
    limitType: asNullableString(info["rateLimitType"]),
    resetAt: resetEpoch !== null ? new Date(resetEpoch * 1000).toISOString() : null,
    overageStatus: asNullableString(info["overageStatus"]),
    isUsingOverage: typeof info["isUsingOverage"] === "boolean" ? info["isUsingOverage"] : null,
  };
}

function modelUsageFromResult(
  result: Record<string, unknown>,
  fallbackModel: string | null,
): Record<string, ModelUsage> | null {
  const perModel = parseObject(result["modelUsage"]);
  const modelKeys = Object.keys(perModel);
  if (modelKeys.length > 0) {
    const out: Record<string, ModelUsage> = {};
    for (const key of modelKeys) {
      const entry = parseObject(perModel[key]);
      const usage: ModelUsage = {
        inputTokens: asNumber(entry["inputTokens"], 0),
        outputTokens: asNumber(entry["outputTokens"], 0),
      };
      const cacheRead = asNumber(entry["cacheReadInputTokens"], 0);
      if (cacheRead > 0) usage.cachedInputTokens = cacheRead;
      const cacheCreation = asNumber(entry["cacheCreationInputTokens"], 0);
      if (cacheCreation > 0) usage.cacheCreationInputTokens = cacheCreation;
      const cost = asNullableNumber(entry["costUSD"]);
      if (cost !== null) usage.costUsd = cost;
      const webSearch = asNumber(entry["webSearchRequests"], 0);
      if (webSearch > 0) usage.webSearchRequests = webSearch;
      const ctxWindow = asNullableNumber(entry["contextWindow"]);
      if (ctxWindow !== null) usage.contextWindow = ctxWindow;
      const maxOut = asNullableNumber(entry["maxOutputTokens"]);
      if (maxOut !== null) usage.maxOutputTokens = maxOut;
      out[key] = usage;
    }
    return out;
  }

  // Fallback: synthesize single-model usage from `result.usage` if present.
  const usageObj = parseObject(result["usage"]);
  if (Object.keys(usageObj).length === 0) return null;
  const model = asNullableString(result["model"]) ?? fallbackModel;
  if (!model) return null;
  const usage: ModelUsage = {
    inputTokens: asNumber(usageObj["input_tokens"], 0),
    outputTokens: asNumber(usageObj["output_tokens"], 0),
  };
  const cacheRead = asNumber(usageObj["cache_read_input_tokens"], 0);
  if (cacheRead > 0) usage.cachedInputTokens = cacheRead;
  const cacheCreation = asNumber(usageObj["cache_creation_input_tokens"], 0);
  if (cacheCreation > 0) usage.cacheCreationInputTokens = cacheCreation;
  return { [model]: usage };
}

export function parseClaudeStreamJson(stdout: string): ClaudeParsedResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  const rateLimits: RateLimitInfo[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event["type"], "");

    if (type === "system" && asString(event["subtype"], "") === "init") {
      sessionId = asNullableString(event["session_id"]) ?? sessionId;
      model = asNullableString(event["model"]) ?? model;
      continue;
    }

    if (type === "rate_limit_event") {
      const info = rateLimitFromEvent(event);
      if (info) rateLimits.push(info);
      continue;
    }

    if (type === "assistant") {
      sessionId = asNullableString(event["session_id"]) ?? sessionId;
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
      sessionId = asNullableString(event["session_id"]) ?? sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null,
      modelUsage: null,
      summary: assistantTexts.join("\n\n").trim() || null,
      isError: false,
      errorCode: null,
      stopReason: null,
      terminalReason: null,
      numTurns: null,
      durationApiMs: null,
      permissionDenials: null,
      rateLimits,
      finalEvent: null,
    };
  }

  const modelUsage = modelUsageFromResult(finalResult, model);
  const costRaw = finalResult["total_cost_usd"];
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult["result"], assistantTexts.join("\n\n")).trim() || null;
  const isError = finalResult["is_error"] === true;

  let errorCode: string | null = null;
  if (isClaudeMaxTurns(stdout)) {
    errorCode = "max_turns";
  } else if (classifyClaudeAuthFromResult(finalResult)) {
    // Structured signal beats regex — set the canonical errorCode so
    // execute.ts doesn't need a separate regex pass for the same fact.
    errorCode = "auth_required";
  }

  const denials = finalResult["permission_denials"];
  const permissionDenials = Array.isArray(denials) && denials.length > 0 ? denials : null;

  return {
    sessionId,
    model,
    costUsd,
    modelUsage,
    summary,
    isError,
    errorCode,
    stopReason: asNullableString(finalResult["stop_reason"]),
    terminalReason: asNullableString(finalResult["terminal_reason"]),
    numTurns: asNullableNumber(finalResult["num_turns"]),
    durationApiMs: asNullableNumber(finalResult["duration_api_ms"]),
    permissionDenials,
    rateLimits,
    finalEvent: finalResult,
  };
}

export function toStreamEvents(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    events.push(...parseStreamLine(line));
  }
  return events;
}

export function parseStreamLine(line: string): StreamEvent[] {
  const event = parseJson(line);
  if (!event) return [];

  const type = asString(event["type"], "");

  if (type === "system" && asString(event["subtype"], "") === "init") {
    return [{
      type: "system",
      subtype: "init",
      model: asNullableString(event["model"]),
      cwd: asNullableString(event["cwd"]),
      tools: Array.isArray(event["tools"]) ? event["tools"] as string[] : null,
      permissionMode: asNullableString(event["permissionMode"]),
      slashCommands: asStringArray(event["slash_commands"]),
      skills: asStringArray(event["skills"]),
      ...baseFieldsFromEvent(event, null),
    }];
  }

  if (type === "rate_limit_event") {
    const info = rateLimitFromEvent(event);
    if (!info) return [];
    return [{
      type: "rate_limit",
      status: info.status,
      limitType: info.limitType,
      resetAt: info.resetAt,
      overageStatus: info.overageStatus,
      isUsingOverage: info.isUsingOverage,
      ...baseFieldsFromEvent(event, null),
    }];
  }

  if (type === "permission-mode") {
    const mode = asNullableString(event["permissionMode"]);
    if (!mode) return [];
    return [{
      type: "permission_mode",
      permissionMode: mode,
      ...baseFieldsFromEvent(event, null),
    }];
  }

  if (type === "assistant") {
    const message = parseObject(event["message"]);
    // Claude emits a "synthetic" assistant message (model === "<synthetic>")
    // with `error: "authentication_failed"` immediately before the failing
    // `result` event when auth is broken. Its text duplicates the result
    // text (e.g. "Invalid API key · Fix external API key") and confuses
    // consumers that render assistant messages — drop it entirely. The
    // auth_required signal is emitted from the result branch below where
    // we also have `api_error_status` available.
    if (
      asString(event["error"], "") === "authentication_failed" &&
      asString(message["model"], "") === "<synthetic>"
    ) {
      return [];
    }
    const messageId = asNullableString(message["id"]);
    const base = baseFieldsFromEvent(event, messageId);
    const out: StreamEvent[] = [];
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      const blockType = asString(block["type"], "");
      if (blockType === "text") {
        out.push({ type: "assistant", text: asString(block["text"], ""), ...base });
      } else if (blockType === "thinking") {
        out.push({ type: "thinking", text: asString(block["thinking"], ""), ...base });
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          toolCallId: asNullableString(block["id"]),
          name: asString(block["name"], ""),
          input: block["input"],
          ...base,
        });
      } else if (blockType === "tool_result") {
        out.push({
          type: "tool_result",
          toolCallId: asNullableString(block["tool_use_id"]),
          // Claude's wire `tool_result` block carries only `tool_use_id`, not
          // the tool name. The session/exec tool-name tracker fills this by
          // correlating with the earlier `tool_call`.
          toolName: null,
          content: asString(block["content"], ""),
          isError: block["is_error"] === true,
          exitCode: null,
          ...base,
        });
      }
    }
    return out;
  }

  if (type === "user") {
    // Claude encodes tool results as a `user` event carrying tool_result blocks.
    const message = parseObject(event["message"]);
    const messageId = asNullableString(message["id"]);
    const base = baseFieldsFromEvent(event, messageId);
    const out: StreamEvent[] = [];
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      if (asString(block["type"], "") === "tool_result") {
        out.push({
          type: "tool_result",
          toolCallId: asNullableString(block["tool_use_id"]),
          // Claude's wire `tool_result` block carries only `tool_use_id`, not
          // the tool name. The session/exec tool-name tracker fills this by
          // correlating with the earlier `tool_call`.
          toolName: null,
          content: asString(block["content"], ""),
          isError: block["is_error"] === true,
          exitCode: null,
          ...base,
        });
      }
    }
    return out;
  }

  if (type === "result") {
    const out: StreamEvent[] = [];
    const auth = classifyClaudeAuthFromResult(event);
    if (auth) {
      out.push({
        type: "auth_required",
        httpStatus: auth.httpStatus,
        reason: auth.reason,
        loginCommand: CLAUDE_LOGIN_COMMAND,
        message: auth.message,
        ...baseFieldsFromEvent(event, null),
      });
    }
    out.push({
      type: "result",
      text: asString(event["result"], ""),
      costUsd: asNullableNumber(event["total_cost_usd"]),
      isError: event["is_error"] === true,
      stopReason: asNullableString(event["stop_reason"]),
      terminalReason: asNullableString(event["terminal_reason"]),
      numTurns: asNullableNumber(event["num_turns"]),
      durationMs: asNullableNumber(event["duration_ms"]),
      ...baseFieldsFromEvent(event, null),
    });
    return out;
  }

  // Forward-compat: surface any unrecognized event type with full base fields
  // + raw. Lets consumers see new CLI event types without a library bump.
  return [{
    type: "unknown",
    subtype: type,
    ...baseFieldsFromEvent(event, null),
  }];
}

/**
 * Loose text-match fallback for `isClaudeAuthRequired` — used by execute.ts
 * before the structured `api_error_status` check was added, and kept for
 * forward-compat when Claude introduces new auth phrasings before we model
 * them. Prefer `classifyClaudeAuthFromResult` for new code; it works off
 * structured wire fields plus the documented user-facing strings.
 *
 * Source of strings: https://code.claude.com/docs/en/errors
 */
const CLAUDE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?(?:claude\s+(?:auth\s+)?login|\/login)`?|login\s+required|requires\s+login|unauthorized|authentication\s+required|authentication_failed|authentication_error|oauth\s+token\s+(?:has\s+expired|revoked)|does\s+not\s+meet\s+scope\s+requirement|invalid\s+api\s+key|invalid\s+bearer\s+token|disabled\s+organization|routines\s+are\s+disabled)/i;
const CLAUDE_UNKNOWN_SESSION_RE = /no conversation found with session id|unknown session|session .* not found/i;

export function isClaudeUnknownSessionError(stdout: string, stderr: string): boolean {
  return CLAUDE_UNKNOWN_SESSION_RE.test(stdout) || CLAUDE_UNKNOWN_SESSION_RE.test(stderr);
}

export function isClaudeAuthRequired(stdout: string, stderr: string): boolean {
  return CLAUDE_AUTH_REQUIRED_RE.test(stdout) || CLAUDE_AUTH_REQUIRED_RE.test(stderr);
}

/**
 * Map Claude's user-facing auth error text to a stable `AuthRequiredReason`.
 * Strings sourced from https://code.claude.com/docs/en/errors. Case
 * insensitive; lenient substring match — the documented phrasings are
 * stable, but treat unrecognized text as `"unknown"` rather than throwing
 * so consumers still get an event with a usable httpStatus.
 */
function authReasonFromText(text: string): AuthRequiredReason {
  const t = text.toLowerCase();
  // Order matters: "OAuth token has expired" must beat the generic
  // `disabled` substring below.
  if (t.includes("oauth token has expired") || t.includes("token has expired")) return "expired";
  if (t.includes("oauth token revoked") || t.includes("token revoked")) return "revoked";
  if (t.includes("not logged in")) return "missing";
  if (t.includes("does not meet scope requirement") || t.includes("scope requirement")) return "scope";
  if (t.includes("disabled organization") || t.includes("organization has been disabled")) return "disabled_org";
  if (t.includes("routines are disabled")) return "routines_disabled";
  if (t.includes("invalid api key")) return "invalid";
  // Bearer token / Bedrock security token fall under "invalid"
  if (t.includes("invalid bearer token") || t.includes("security token") || t.includes("failed to authenticate")) {
    return "invalid";
  }
  return "unknown";
}

/**
 * Classify a Claude `result` event as an auth failure. Returns null when
 * the event isn't an auth failure (success, max-turns, rate-limit, etc.).
 *
 * Detection priority:
 * 1. `api_error_status` is 401 or 403 — definitive HTTP-level auth failure.
 * 2. `is_error: true` AND the result text matches a documented auth string
 *    (covers the CLI's short-circuit "Not logged in" path where
 *    `api_error_status` is null because no HTTP call ever happened).
 *
 * Exported so the streaming session path (`session.ts`) can run the same
 * classification — its `handleResult` consumes `result` events directly
 * and never goes through `parseStreamLine`.
 *
 * @internal
 */
export function classifyClaudeAuthFromResult(event: Record<string, unknown>): {
  httpStatus: number | null;
  reason: AuthRequiredReason;
  message: string | null;
} | null {
  if (event["is_error"] !== true) return null;
  const text = asString(event["result"], "");
  const apiStatus = event["api_error_status"];
  if (apiStatus === 401 || apiStatus === 403) {
    return { httpStatus: apiStatus, reason: authReasonFromText(text), message: text || null };
  }
  // Short-circuit path: no HTTP round trip happened (api_error_status is
  // null), but the result text still carries the documented auth string.
  const reason = authReasonFromText(text);
  if (reason !== "unknown") {
    return { httpStatus: null, reason, message: text || null };
  }
  return null;
}


/**
 * Pulls Claude's inner discriminator and payload out of an `unknown`
 * StreamEvent's `raw`. Returns null for non-Claude events, non-unknown
 * events, or events whose `raw` is not an object.
 *
 * This is opt-in ergonomics — consumers who want to dispatch on Claude's
 * `system` subtypes (`away_summary`, `compact_boundary`, `turn_duration`,
 * `api_error`, `bridge_status`, etc.) can use this instead of reaching
 * into `event.raw` directly. `content` is returned as `unknown` to avoid
 * silently coercing non-string or object payloads.
 */
export function getClaudeUnknownDetails(
  event: StreamEvent,
): { subtype: string | null; content: unknown } | null {
  if (event.type !== "unknown") return null;
  if (event.providerType !== "claude") return null;
  const raw = event.raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    subtype: asNullableString(r["subtype"]),
    content: r["content"],
  };
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
