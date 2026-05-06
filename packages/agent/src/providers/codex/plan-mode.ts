/**
 * System-prompt preamble injected when running Codex in plan mode.
 *
 * Codex *does* have a native Plan mode in the TUI — it's one of three
 * collaboration modes (Plan, Pair, Execute), activated by `/plan` or
 * Shift+Tab. In that flow the agent emits a structured plan via
 * `item/plan/delta` notifications and finalizes via `ConsolidateProposedPlan`.
 *
 * However, **`codex exec` exposes no flag to start in plan mode** and the
 * JSON-RPC `collaboration_mode` parameter is per-message at runtime, not a
 * startup option. So for non-interactive runs we approximate the UX with:
 *   1. `--sandbox read-only` — the permission boundary (writes get rejected).
 *   2. This preamble — tells the agent up front to investigate-and-propose
 *      rather than attempt-and-fail.
 *
 * The agent's final assistant message ends up containing the plan, which
 * lands in `ExecutionResult.summary`. If/when Codex exposes plan mode
 * through `exec` (e.g. `-c collaboration_mode=plan`), we should switch to
 * the native flow and surface `item/plan/delta` events directly.
 *
 * See `internal-docs/codex-plan-mode.md` for the full research notes —
 * config keys, internal Rust enum variants, JSON-RPC notification names,
 * and the two integration paths we could take for native support.
 */
export const CODEX_PLAN_MODE_PREAMBLE = `# Plan Mode

You are running in read-only plan mode. The sandbox will reject any file edits
or mutating shell commands.

Your job:
1. Investigate the codebase enough to understand what the user is asking for.
2. Produce a clear written plan describing exactly what you would do, broken
   into concrete steps. Mention specific files, functions, and the changes
   you would make.
3. End with the plan as your final assistant message. Do NOT attempt edits —
   they will be rejected by the sandbox and waste the turn.

The user will review your plan and either approve it (re-running you with
write permissions on the same session) or refine the request. Treat your
final message as a proposal, not a status update.`;

/**
 * Combine the plan-mode preamble with any existing developer instructions.
 * Returns the preamble alone if no instructions were provided.
 */
export function withPlanModePreamble(instructions: string | null): string {
  if (!instructions) return CODEX_PLAN_MODE_PREAMBLE;
  return `${CODEX_PLAN_MODE_PREAMBLE}\n\n${instructions}`;
}
