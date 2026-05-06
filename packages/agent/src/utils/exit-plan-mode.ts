import type { UserInputRequest } from "../types.js";

/**
 * Structured payload for an `ExitPlanMode` permission request.
 *
 * The agent calls this when it has finished planning and wants the user to
 * approve the plan. The host receives the request via `onUserInputRequest`
 * and decides whether to exit plan mode (allow → the agent continues in the
 * permission mode the user picked) or stay in plan mode (deny).
 */
export interface ExitPlanModeRequest {
  plan: string;
}

/**
 * Parse an `ExitPlanMode` permission request.
 *
 * Returns the structured plan payload if the request is for `ExitPlanMode`,
 * or `null` if it's a different tool. The plan text only flows through the
 * live SDK control_request — it is not persisted to the saved transcript —
 * so callers should capture it here when they want to surface it to the user.
 *
 * @example
 * ```ts
 * onUserInputRequest: async (req) => {
 *   const plan = parseExitPlanMode(req);
 *   if (plan) {
 *     const approved = await showPlanApprovalUI(plan.plan);
 *     return { allow: approved };
 *   }
 *   return { allow: true };
 * }
 * ```
 */
export function parseExitPlanMode(req: UserInputRequest): ExitPlanModeRequest | null {
  if (req.toolName !== "ExitPlanMode") return null;
  const plan = (req.input as Record<string, unknown>)["plan"];
  if (typeof plan !== "string") return null;
  return { plan };
}
