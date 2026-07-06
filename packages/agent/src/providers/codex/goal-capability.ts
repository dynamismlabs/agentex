import type { GoalCapability } from "../../types.js";

/**
 * Codex carries goals as durable thread state mutated by model tools
 * (create_goal/update_goal/get_goal). Advisory — the model self-reports; no
 * turn-end gate. Goal mode is experimental and feature-gated upstream, so the
 * native arm is best-effort and falls back to emulation (see spec §7.2).
 *
 * Lives in its own leaf module (not `session.ts`) so `index.ts` can read the
 * static `capabilities.goals` field without pulling the heavy session machinery
 * into the module graph (spec §5.1).
 */
export const codexGoalCapability: GoalCapability = {
  mechanism: "model-tools",
  enforced: false,
  statuses: ["active", "paused", "met", "blocked", "cleared"],
  clears: "manual",
  telemetry: true,
};
