import type {
  GoalSentinel,
  GoalSentinelContext,
  GoalSentinelVerdict,
  TurnResult,
} from "../types.js";

/** Normalize a sentinel's `boolean | {met,nudge}` return into a verdict. */
export async function runSentinel(
  sentinel: GoalSentinel,
  ctx: GoalSentinelContext,
): Promise<GoalSentinelVerdict> {
  const out = await sentinel(ctx);
  if (typeof out === "boolean") return { met: out };
  return { met: out.met === true, ...(out.nudge ? { nudge: out.nudge } : {}) };
}

/**
 * The objective doubles as the first turn's directive (matching native `/goal`,
 * which starts a turn immediately with the condition). Kept verbatim so a goal
 * like "All tests pass under `pnpm test`" reads naturally as a task.
 */
export function buildKickoffMessage(objective: string): string {
  return objective;
}

/** Continuation message sent when the sentinel judges the goal not-yet-met. */
export function defaultNudge(objective: string, iterations: number): string {
  return [
    `The goal is not yet satisfied (attempt ${iterations + 1}). Keep working until it is fully met, then stop.`,
    "",
    "Goal:",
    objective,
  ].join("\n");
}

/**
 * Prompt for the default sentinel's self-assessment turn. The model must answer
 * with a single leading token so the parse is unambiguous.
 */
export function buildAssessmentPrompt(objective: string): string {
  return [
    "Assess ONLY whether the goal below is now fully and verifiably met by the work done so far in this conversation.",
    "Answer with exactly one word on the first line: YES if it is fully met, otherwise NO.",
    "Do not perform any further work; do not edit files. Just judge.",
    "",
    "Goal:",
    objective,
  ].join("\n");
}

/**
 * Parse a yes/no self-assessment answer. Conservative: only an explicit
 * affirmative ("yes"/"met"/"complete"/"done"/"satisfied" as the first token, or
 * a clear standalone "YES") counts as met. Anything ambiguous → not met, so the
 * loop keeps working rather than declaring premature success.
 */
export function parseAssessment(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  const firstToken = (trimmed.split(/[\s,.:!]+/)[0] ?? "").replace(/[^a-z]/g, "");
  if (["no", "not", "incomplete", "unmet", "false"].includes(firstToken)) return false;
  if (["yes", "met", "complete", "completed", "done", "satisfied", "true"].includes(firstToken)) {
    return true;
  }
  // Fall back to a strict scan for an unambiguous affirmative phrase.
  return /\b(goal\s+is\s+)?(fully\s+)?(met|complete|completed|satisfied)\b/.test(trimmed)
    && !/\bnot\b/.test(trimmed);
}

/**
 * Build the library's default sentinel: ask the running provider to self-assess
 * whether the goal is met. Borrows Claude's design (judge from what the working
 * model surfaced) but uses the same session — so it adds a meta-turn to the
 * transcript. NOTE: the meta-turn runs with the session's normal tool/permission
 * grant; the prompt ASKS the model not to act, but that is not enforced, so this
 * is not a true read-only judge. Hosts with a deterministic check (e.g. run
 * tests) should pass their own `sentinel`; this is the of-last-resort default.
 *
 * `metaSend` runs a turn and resolves with its TurnResult. The controller wires
 * it so the meta-turn's own settle is ignored by the goal loop (no recursion).
 */
export function createDefaultSentinel(deps: {
  metaSend: (message: string) => Promise<TurnResult>;
}): GoalSentinel {
  return async (ctx: GoalSentinelContext): Promise<GoalSentinelVerdict> => {
    const turn = await deps.metaSend(buildAssessmentPrompt(ctx.objective));
    return { met: parseAssessment(turn.summary ?? "") };
  };
}
