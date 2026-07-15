import type {
  BaseStreamEventFields,
  GoalSource,
  StreamEvent,
  TokenUsage,
} from "../../types.js";
import { normalizeCodexGoalRecord } from "../../goals/normalize.js";

const PROVIDER_TYPE = "codex";

export interface CodexParsedResult {
  sessionId: string | null;
  /**
   * Codex doesn't emit `model` in its NDJSON output — always null from
   * stdout. Executors should fall back to the requested model.
   */
  model: string | null;
  usage: TokenUsage | null;
  costUsd: number | null;
  summary: string | null;
  isError: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** Final `turn.completed` / `turn.failed` / `error` event verbatim. */
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

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asMessagePhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function codexBackgroundTaskState(
  value: unknown,
): { phase: "started" | "completed"; status: "running" | "completed" | "failed" | "stopped"; summary: string | null } {
  const state = parseObject(value);
  const nativeStatus = asString(state["status"], "");
  const summary = asNullableString(state["message"]);
  if (nativeStatus === "completed") return { phase: "completed", status: "completed", summary };
  if (nativeStatus === "errored" || nativeStatus === "notFound") {
    return { phase: "completed", status: "failed", summary };
  }
  if (nativeStatus === "interrupted" || nativeStatus === "shutdown") {
    return { phase: "completed", status: "stopped", summary };
  }
  return { phase: "started", status: "running", summary };
}

/**
 * Build base fields. For Codex, `eventId` is always null (neither wire
 * format emits a per-line UUID). `sessionId` and `turnId` come from the
 * caller — the v2 parser extracts them from the event's `params`; the
 * NDJSON parser tracks sessionId across lines and leaves turnId null.
 */
function baseFields(
  event: Record<string, unknown>,
  sessionId: string | null,
  messageId: string | null,
  turnId: string | null,
): BaseStreamEventFields {
  return {
    timestamp: new Date().toISOString(),
    providerType: PROVIDER_TYPE,
    sessionId,
    messageId,
    eventId: null,
    turnId,
    parentToolCallId: null,
    raw: event,
  };
}

/**
 * Build a normalized `goal_status` event from a Codex goal record. Returns null
 * when the record is unusable. Shared by the v2 notification path and the
 * NDJSON `event_msg`/`thread_goal_updated` path.
 */
function buildCodexGoalEvent(
  goal: Record<string, unknown>,
  base: BaseStreamEventFields,
  source: GoalSource = "model",
): StreamEvent | null {
  const fields = normalizeCodexGoalRecord(goal, source);
  if (!fields) return null;
  const ev: Extract<StreamEvent, { type: "goal_status" }> = {
    type: "goal_status",
    objective: fields.objective,
    status: fields.status,
    met: fields.met,
    enforced: fields.enforced,
    source: fields.source,
    ...base,
  };
  if (fields.blockedReason !== undefined) ev.blockedReason = fields.blockedReason;
  if (fields.tokensUsed !== undefined) ev.tokensUsed = fields.tokensUsed;
  if (fields.timeUsedSeconds !== undefined) ev.timeUsedSeconds = fields.timeUsedSeconds;
  if (fields.tokenBudget !== undefined) ev.tokenBudget = fields.tokenBudget;
  return ev;
}

// ---------------------------------------------------------------------------
// Run-level parser used by executeCodexProvider to summarize a full stdout.
// Operates on NDJSON only (executor uses `codex exec --json`).
// ---------------------------------------------------------------------------

export function parseCodexJsonl(stdout: string): CodexParsedResult {
  let sessionId: string | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let hasUsage = false;
  let summary: string | null = null;
  let isError = false;
  let errorMessage: string | null = null;
  let finalEvent: Record<string, unknown> | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event["type"], "");

    if (type === "thread.started") {
      sessionId = asNullableString(event["thread_id"]) ?? sessionId;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event["item"]);
      if (asString(item["type"], "") === "agent_message") {
        const directText = asString(item["text"], "");
        if (directText) {
          summary = directText;
        } else {
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
      const cachedInputTokens = asNumber(usage["cached_input_tokens"], 0);
      if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCachedInputTokens += cachedInputTokens;
        hasUsage = true;
      }
      finalEvent = event;
      continue;
    }

    if (type === "turn.failed") {
      isError = true;
      errorMessage = asNullableString(event["message"]) ?? asNullableString(event["error"]);
      finalEvent = event;
      continue;
    }

    if (type === "error") {
      isError = true;
      errorMessage = asNullableString(event["message"]);
      finalEvent = event;
      continue;
    }
  }

  const usage: TokenUsage | null = hasUsage ? {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    ...(totalCachedInputTokens > 0 ? { cachedInputTokens: totalCachedInputTokens } : {}),
  } : null;

  return {
    sessionId,
    model: null,
    usage,
    costUsd: null, // Codex doesn't report cost
    summary,
    isError,
    errorCode: null,
    errorMessage,
    finalEvent,
  };
}

// ---------------------------------------------------------------------------
// Stream-line parser. Auto-detects wire format:
//  - `codex exec --json` NDJSON: `{"type":"...","...": ...}`
//  - `codex --json` v2 JSON-RPC: `{"jsonrpc":"2.0","method":"...","params":{...}}`
// Both shapes produce the same StreamEvent variants so downstream
// consumers don't branch on format.
// ---------------------------------------------------------------------------

/**
 * Parse a single Codex line into a StreamEvent.
 *
 * @param line   Raw JSON text.
 * @param sessionId  Caller-tracked thread id (NDJSON emits it once on
 *                   `thread.started` and the executor threads it through).
 *                   v2 parses it from `params.threadId` directly and
 *                   ignores this arg.
 */
export function parseCodexStreamLine(
  line: string,
  sessionId: string | null = null,
): StreamEvent | null {
  const event = parseJson(line);
  if (!event) return null;

  // v2 JSON-RPC notification: has `method` + `params`.
  if (typeof event["method"] === "string") {
    return parseV2Notification(event);
  }

  // NDJSON legacy format: has `type`.
  return parseNdjsonEvent(event, sessionId);
}

// ---------------------------------------------------------------------------
// v2 JSON-RPC notifications (codex --json app-server mode)
// ---------------------------------------------------------------------------

function parseV2Notification(event: Record<string, unknown>): StreamEvent | null {
  const method = asString(event["method"], "");
  const params = parseObject(event["params"]);

  // Extract thread + turn scope. Most notifications carry threadId at the
  // top of params; thread/started nests it under thread.id.
  const thread = parseObject(params["thread"]);
  const threadId =
    asNullableString(params["threadId"]) ??
    asNullableString(thread["id"]);

  // turn/started + turn/completed nest the turn object; everything else
  // puts turnId at the top of params.
  const turn = parseObject(params["turn"]);
  const turnId =
    asNullableString(params["turnId"]) ??
    asNullableString(turn["id"]);

  const makeBase = (messageId: string | null) =>
    baseFields(event, threadId, messageId, turnId);

  // ---- Thread lifecycle ----

  if (method === "thread/started") {
    return {
      type: "system",
      subtype: "init",
      model: null,
      cwd: asNullableString(thread["cwd"]),
      tools: null,
      permissionMode: null,
      ...makeBase(null),
    };
  }

  // ---- Turn lifecycle ----

  if (method === "turn/started") {
    // Lifecycle marker; items will follow. Skip to reduce noise.
    return null;
  }

  if (method === "turn/completed") {
    // codex 0.130 reports turn failures via `turn/completed` with
    // `turn.status: "failed"` (+ `turn.error.message`), NOT only `turn/failed`.
    // Surface that as an errored result instead of a clean completion.
    const status = asNullableString(turn["status"]);
    const failed = status === "failed" || status === "cancelled";
    const turnError = parseObject(turn["error"]);
    return {
      type: "result",
      text: failed ? asString(turnError["message"], "") : "",
      costUsd: null,
      isError: failed,
      stopReason: null,
      terminalReason: status,
      numTurns: null,
      durationMs: asNullableNumber(turn["durationMs"]),
      ...makeBase(null),
    };
  }

  if (method === "turn/failed") {
    return {
      type: "result",
      text: asString(params["message"], ""),
      costUsd: null,
      isError: true,
      stopReason: null,
      terminalReason: asNullableString(turn["status"]),
      numTurns: null,
      durationMs: asNullableNumber(turn["durationMs"]),
      ...makeBase(null),
    };
  }

  // ---- Item lifecycle ----

  if (method === "item/started" || method === "item/completed") {
    const item = parseObject(params["item"]);
    const itemType = asString(item["type"], "");
    const itemId =
      asNullableString(item["id"]) ??
      asNullableString(item["call_id"]);
    const base = makeBase(itemId);
    const isCommandExecution = itemType === "command_execution" || itemType === "commandExecution";

    // Tool starts — emit tool_call on item/started only.
    if (method === "item/started") {
      if (isCommandExecution) {
        return {
          type: "tool_call",
          toolCallId: itemId,
          name: "command_execution",
          input: asString(item["command"], ""),
          ...base,
        };
      }
      if (itemType === "function_call") {
        return {
          type: "tool_call",
          toolCallId: itemId,
          name: asString(item["name"], "function_call"),
          input: item["arguments"] ?? item["input"] ?? "",
          ...base,
        };
      }
      // reasoning, agentMessage, userMessage — wait for item/completed.
      return null;
    }

    // item/completed — emit the terminal event for each item type.
    if (isCommandExecution) {
      const exitCode = asNullableNumber(item["exit_code"] ?? item["exitCode"]);
      const status = asString(item["status"], "");
      return {
        type: "tool_result",
        toolCallId: itemId,
        toolName: "command_execution",
        content: asString(item["aggregated_output"], asString(item["aggregatedOutput"], "")),
        isError: status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0),
        exitCode,
        ...base,
      };
    }
    if (itemType === "function_call") {
      const output = item["output"] ?? item["result"] ?? "";
      return {
        type: "tool_result",
        toolCallId: itemId,
        toolName: asString(item["name"], "function_call"),
        content: typeof output === "string" ? output : JSON.stringify(output),
        isError: item["status"] === "failed",
        exitCode: null,
        ...base,
      };
    }
    if (itemType === "agentMessage") {
      const directText = asString(item["text"], "");
      if (directText || directText === "") {
        const phase = asMessagePhase(item["phase"]);
        return {
          type: "assistant",
          text: directText,
          ...(phase ? { phase } : {}),
          ...base,
        };
      }
    }
    if (itemType === "reasoning") {
      // Reasoning content may be empty / encrypted out-of-band — consumers
      // that need the raw payload read it from `raw`.
      const text =
        asString(item["text"], "") ||
        extractReasoningText(item);
      return {
        type: "thinking",
        text,
        ...base,
      };
    }
    if (itemType === "subAgentActivity") {
      const taskId = asString(item["agentThreadId"], "");
      const kind = asString(item["kind"], "");
      if (!taskId || (kind !== "started" && kind !== "interacted" && kind !== "interrupted")) {
        return {
          type: "unknown",
          subtype: `item/completed:${itemType}`,
          ...base,
        };
      }
      return {
        type: "background_task",
        taskId,
        taskType: "subagent",
        phase: kind === "started" ? "started" : kind === "interrupted" ? "completed" : "progress",
        status: kind === "interrupted" ? "stopped" : "running",
        description: asNullableString(item["agentPath"]),
        summary: null,
        parentTaskId: null,
        ...base,
      };
    }
    if (itemType === "collabAgentToolCall") {
      const tool = asString(item["tool"], "");
      const taskIds = parseStringArray(item["receiverThreadIds"]);
      const states = parseObject(item["agentsStates"]);
      const taskId = taskIds[0] ?? Object.keys(states)[0] ?? "";
      // A completed spawnAgent call means the child exists, not that the
      // child's own turn is complete. Its state (usually pendingInit) and a
      // later thread/read response carry the child lifecycle.
      if (!taskId || (tool !== "spawnAgent" && !(taskId in states))) {
        return {
          type: "unknown",
          subtype: `item/completed:${itemType}`,
          ...base,
        };
      }
      const state = codexBackgroundTaskState(states[taskId]);
      return {
        type: "background_task",
        taskId,
        taskType: "subagent",
        phase: state.phase,
        status: state.status,
        description: asNullableString(item["prompt"]),
        summary: state.summary,
        parentTaskId: null,
        ...base,
      };
    }
    if (itemType === "userMessage") {
      // Consumer persists user input on the write path before calling send().
      // We don't re-emit it here to keep a single source of truth.
      return null;
    }
    // Unknown item type — surface as unknown.
    return {
      type: "unknown",
      subtype: `item/completed:${itemType}`,
      ...base,
    };
  }

  // ---- Streaming deltas: block-level only for v1; skip token deltas. ----

  if (method === "item/agentMessage/delta" || method === "item/reasoning/delta") {
    return null;
  }

  // ---- Rate limits ----

  if (method === "account/rateLimits/updated") {
    const rateLimits = parseObject(params["rateLimits"]);
    const primary = parseObject(rateLimits["primary"]);
    const usedPercent = asNullableNumber(primary["usedPercent"]);
    return {
      type: "rate_limit",
      status: usedPercent !== null && usedPercent >= 100 ? "rejected" : "allowed",
      limitType: asNullableString(rateLimits["limitId"]),
      resetAt: null,
      overageStatus: null,
      isUsingOverage: null,
      ...makeBase(null),
    };
  }

  // ---- Goal lifecycle (experimental; wire shape unofficial — read loosely) ----

  if (method === "thread/goal/updated" || method === "thread/goal/set") {
    const ev = buildCodexGoalEvent(parseObject(params["goal"]), makeBase(null));
    if (ev) return ev;
  }

  if (method === "thread/goal/cleared") {
    const goal = parseObject(params["goal"]);
    return {
      type: "goal_status",
      objective: asString(goal["objective"], ""),
      status: "cleared",
      met: false,
      enforced: false,
      source: "host",
      ...makeBase(null),
    };
  }

  // ---- Pure telemetry / status ----

  if (
    method === "thread/tokenUsage/updated" ||
    method === "thread/status/changed" ||
    method === "mcpServer/startupStatus/updated"
  ) {
    return null;
  }

  // ---- Forward-compat: unknown method ----

  return {
    type: "unknown",
    subtype: method,
    ...makeBase(null),
  };
}

function extractReasoningText(item: Record<string, unknown>): string {
  // Codex reasoning items carry summary and content arrays. Concatenate
  // any visible text fragments for display; fall back to "" if all empty
  // or encrypted.
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const arr = Array.isArray(item[key]) ? (item[key] as unknown[]) : [];
    for (const entry of arr) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      const text = asString(block["text"], "");
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// NDJSON format (codex exec --json)
// ---------------------------------------------------------------------------

function parseNdjsonEvent(
  event: Record<string, unknown>,
  sessionId: string | null,
): StreamEvent | null {
  const type = asString(event["type"], "");

  if (type === "thread.started") {
    const threadId = asNullableString(event["thread_id"]);
    return {
      type: "system",
      subtype: "init",
      model: null,
      cwd: null,
      tools: null,
      permissionMode: null,
      ...baseFields(event, threadId, null, null),
    };
  }

  if (type === "item.started") {
    const item = parseObject(event["item"]);
    const itemType = asString(item["type"], "");
    const itemId = asNullableString(item["id"]) ?? asNullableString(item["call_id"]);
    const base = baseFields(event, sessionId, itemId, null);
    if (itemType === "command_execution") {
      return {
        type: "tool_call",
        toolCallId: itemId,
        name: "command_execution",
        input: asString(item["command"], ""),
        ...base,
      };
    }
    if (itemType === "function_call") {
      return {
        type: "tool_call",
        toolCallId: itemId,
        name: asString(item["name"], "function_call"),
        input: item["arguments"] ?? item["input"] ?? "",
        ...base,
      };
    }
  }

  if (type === "item.completed") {
    const item = parseObject(event["item"]);
    const itemType = asString(item["type"], "");
    const itemId = asNullableString(item["id"]) ?? asNullableString(item["call_id"]);
    const base = baseFields(event, sessionId, itemId, null);
    if (itemType === "command_execution") {
      const exitCode = asNullableNumber(item["exit_code"]);
      return {
        type: "tool_result",
        toolCallId: itemId,
        toolName: "command_execution",
        content: asString(item["aggregated_output"], ""),
        isError: exitCode !== null && exitCode !== 0,
        exitCode,
        ...base,
      };
    }
    if (itemType === "function_call") {
      const output = item["output"] ?? item["result"] ?? "";
      return {
        type: "tool_result",
        toolCallId: itemId,
        toolName: asString(item["name"], "function_call"),
        content: typeof output === "string" ? output : JSON.stringify(output),
        isError: item["status"] === "failed",
        exitCode: null,
        ...base,
      };
    }
    if (itemType === "agent_message") {
      const phase = asMessagePhase(item["phase"]);
      const directText = asString(item["text"], "");
      if (directText) {
        return {
          type: "assistant",
          text: directText,
          ...(phase ? { phase } : {}),
          ...base,
        };
      }
      const content = Array.isArray(item["content"]) ? item["content"] : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block["type"], "") === "output_text") {
          return {
            type: "assistant",
            text: asString(block["text"], ""),
            ...(phase ? { phase } : {}),
            ...base,
          };
        }
      }
    }
    if (itemType === "reasoning") {
      const text = asString(item["text"], "") || extractReasoningText(item);
      return {
        type: "thinking",
        text,
        ...base,
      };
    }
  }

  if (type === "turn.completed") {
    return {
      type: "result",
      text: "",
      costUsd: null,
      isError: false,
      stopReason: null,
      terminalReason: null,
      numTurns: null,
      durationMs: null,
      ...baseFields(event, sessionId, null, null),
    };
  }

  if (type === "error" || type === "turn.failed") {
    return {
      type: "result",
      text: asString(event["message"], ""),
      costUsd: null,
      isError: true,
      stopReason: null,
      terminalReason: null,
      numTurns: null,
      durationMs: null,
      ...baseFields(event, sessionId, null, null),
    };
  }

  // ---- Goal lifecycle (experimental; wire shape unofficial — read loosely) ----
  // Observed on this machine as an `event_msg` wrapper; also tolerate the bare
  // `thread_goal_updated` / `thread.goal.updated` spellings.
  if (type === "event_msg") {
    const payload = parseObject(event["payload"]);
    if (asString(payload["type"], "") === "thread_goal_updated") {
      const tid = asNullableString(payload["threadId"]) ?? sessionId;
      const ev = buildCodexGoalEvent(parseObject(payload["goal"]), baseFields(event, tid, null, null));
      if (ev) return ev;
    }
  }

  if (type === "thread_goal_updated" || type === "thread.goal.updated") {
    const tid = asNullableString(event["threadId"]) ?? asNullableString(event["thread_id"]) ?? sessionId;
    const ev = buildCodexGoalEvent(parseObject(event["goal"]), baseFields(event, tid, null, null));
    if (ev) return ev;
  }

  // Forward-compat: surface unknown event types.
  return {
    type: "unknown",
    subtype: type,
    ...baseFields(event, sessionId, null, null),
  };
}

// ---------------------------------------------------------------------------
// Error detection utilities (unchanged)
// ---------------------------------------------------------------------------

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
