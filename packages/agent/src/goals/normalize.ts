import type {
  GoalBlockedReason,
  GoalSource,
  GoalState,
  GoalStatus,
  StreamEvent,
} from "../types.js";

/** Max objective length, matching both native providers (Claude + Codex). */
export const GOAL_OBJECTIVE_MAX = 4000;

/** The `goal_status` member of the StreamEvent union. */
export type GoalStatusEvent = Extract<StreamEvent, { type: "goal_status" }>;

/**
 * Codex's goal-management tool names. These surface as ordinary
 * `tool_call`/`tool_result` events, NOT as `goal_status` — goal state is keyed
 * off the authoritative `thread_goal_updated` notification instead. This Set is
 * a host-facing recognizer for code that wants to spot the model managing its
 * goal from the tool stream; the library does not consume it internally.
 */
export const CODEX_GOAL_TOOLS = new Set(["get_goal", "create_goal", "update_goal"]);

/**
 * Normalized goal fields — everything a `goal_status` event needs except the
 * `BaseStreamEventFields` envelope. Parsers fill the envelope; the controller
 * fills it for synthetic (emulation) transitions.
 */
export interface NormalizedGoalFields {
  objective: string;
  status: GoalStatus;
  met: boolean;
  enforced: boolean;
  source: GoalSource;
  blockedReason?: GoalBlockedReason;
  errorMessage?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number;
}

/** A goal status is terminal when no further work happens against it. */
export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status === "met" || status === "cleared" || status === "blocked";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize a Claude `goal_status` attachment
 * (`{type:"goal_status", met, sentinel, condition}`) into goal fields. Returns
 * null when the object isn't a goal_status attachment. Claude goals are always
 * sentinel-enforced and binary (`met:false → active`, `met:true → met`).
 */
export function normalizeClaudeGoalAttachment(
  attachment: Record<string, unknown> | null | undefined,
): NormalizedGoalFields | null {
  if (!attachment || attachment["type"] !== "goal_status") return null;
  const condition = typeof attachment["condition"] === "string" ? attachment["condition"] : "";
  const met = attachment["met"] === true;
  return {
    objective: condition,
    status: met ? "met" : "active",
    met,
    enforced: true,
    source: "sentinel",
  };
}

/**
 * Map a raw Codex goal status string into the normalized ladder. Codex's
 * documented statuses are `active|paused|complete|budget-limited`; we also
 * tolerate the reverse-engineered/aliased spellings (`completed`, `achieved`,
 * `budget_limited`, `budgetLimited`, `pursuing`, `blocked`, `cleared`) so the
 * parser survives wire drift.
 */
export function normalizeCodexGoalStatus(raw: string | null | undefined): {
  status: GoalStatus;
  met: boolean;
  blockedReason?: GoalBlockedReason;
} {
  switch ((raw ?? "").toLowerCase()) {
    case "complete":
    case "completed":
    case "achieved":
      return { status: "met", met: true };
    case "paused":
      return { status: "paused", met: false };
    case "budget-limited":
    case "budget_limited":
    case "budgetlimited": // camelCase `budgetLimited`, lowercased
    case "usage-limited":
    case "usage_limited":
    case "usagelimited": // camelCase `usageLimited`, lowercased
      return { status: "blocked", met: false, blockedReason: "budget" };
    case "blocked":
      return { status: "blocked", met: false, blockedReason: "needs_input" };
    case "cleared":
      return { status: "cleared", met: false };
    case "active":
    case "pursuing":
    default:
      return { status: "active", met: false };
  }
}

/**
 * Normalize a Codex goal record (`{objective, status, tokensUsed?,
 * timeUsedSeconds?, tokenBudget?}`) — as carried by `thread_goal_updated` /
 * `thread/goal/updated` notifications or `get_goal`/`update_goal` tool output —
 * into goal fields. Codex goals are advisory (`enforced:false`). `source`
 * reflects who drove the transition: the model can only ever write `active`
 * (create) and `complete` (update); other statuses come from user/system.
 */
export function normalizeCodexGoalRecord(
  goal: Record<string, unknown> | null | undefined,
  source: GoalSource = "model",
): NormalizedGoalFields | null {
  if (!goal || typeof goal !== "object") return null;
  const objective = typeof goal["objective"] === "string" ? goal["objective"] : "";
  const { status, met, blockedReason } = normalizeCodexGoalStatus(
    typeof goal["status"] === "string" ? goal["status"] : null,
  );
  // The model only authors active/complete; paused/blocked/cleared are system.
  const resolvedSource: GoalSource =
    status === "active" || status === "met" ? source : "agentex";
  const fields: NormalizedGoalFields = {
    objective,
    status,
    met,
    enforced: false,
    source: resolvedSource,
  };
  if (blockedReason) fields.blockedReason = blockedReason;
  const tokensUsed = numberOrUndefined(goal["tokensUsed"] ?? goal["tokens_used"]);
  const timeUsed = numberOrUndefined(goal["timeUsedSeconds"] ?? goal["time_used_seconds"]);
  const tokenBudget = numberOrUndefined(goal["tokenBudget"] ?? goal["token_budget"]);
  if (tokensUsed !== undefined) fields.tokensUsed = tokensUsed;
  if (timeUsed !== undefined) fields.timeUsedSeconds = timeUsed;
  if (tokenBudget !== undefined) fields.tokenBudget = tokenBudget;
  return fields;
}

/**
 * Fold a sequence of events into the latest goal state — the building block for
 * resume. Pass the events read back from a transcript (`provider.transcript.read`)
 * or any StreamEvent stream; the most recent `goal_status` wins. Returns null
 * when no goal was ever set (or the goal's last state was terminal and you want
 * to treat that as "no active goal", which the caller decides via `.status`).
 */
export function latestGoalFromEvents(events: Iterable<StreamEvent>): GoalState | null {
  let latest: GoalState | null = null;
  for (const event of events) {
    if (event.type === "goal_status") latest = goalStateFromEvent(event);
  }
  return latest;
}

/** Project a `goal_status` stream event back into the durable `GoalState`. */
export function goalStateFromEvent(event: GoalStatusEvent): GoalState {
  const state: GoalState = {
    objective: event.objective,
    status: event.status,
    met: event.met,
    enforced: event.enforced,
    source: event.source,
    updatedAt: event.timestamp,
  };
  if (event.blockedReason !== undefined) state.blockedReason = event.blockedReason;
  if (event.errorMessage !== undefined) state.errorMessage = event.errorMessage;
  if (event.tokensUsed !== undefined) state.tokensUsed = event.tokensUsed;
  if (event.timeUsedSeconds !== undefined) state.timeUsedSeconds = event.timeUsedSeconds;
  if (event.tokenBudget !== undefined) state.tokenBudget = event.tokenBudget;
  if (event.iterations !== undefined) state.iterations = event.iterations;
  return state;
}
