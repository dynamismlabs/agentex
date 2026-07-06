import type { GoalCapability } from "../../types.js";

/**
 * Claude enforces goals natively via a Stop-hook + fast-model sentinel (the
 * `/goal` command). Binary met/not-met, self-clearing on completion.
 *
 * `statuses` describes the NATIVE producible set. A Claude session that falls to
 * the emulation engine (a custom `sentinel`, or `enforce:"emulate"`) can also
 * produce `blocked` (`blockedReason:"max_iterations"`) — see GoalController.
 *
 * Lives in its own leaf module (not `session.ts`) so `index.ts` can read the
 * static `capabilities.goals` field without pulling the heavy session machinery
 * into the module graph (spec §5.1).
 */
export const claudeGoalCapability: GoalCapability = {
  mechanism: "sentinel",
  enforced: true,
  statuses: ["active", "met", "cleared"],
  clears: "both",
  telemetry: false,
};
