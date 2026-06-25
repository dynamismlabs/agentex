export { GoalController, EMULATED_GOAL_CAPABILITY } from "./controller.js";
export type { GoalControllerDeps } from "./controller.js";
export {
  GOAL_OBJECTIVE_MAX,
  CODEX_GOAL_TOOLS,
  isTerminalGoalStatus,
  normalizeClaudeGoalAttachment,
  normalizeCodexGoalStatus,
  normalizeCodexGoalRecord,
  goalStateFromEvent,
  latestGoalFromEvents,
} from "./normalize.js";
export type { GoalStatusEvent, NormalizedGoalFields } from "./normalize.js";
export {
  runSentinel,
  createDefaultSentinel,
  buildKickoffMessage,
  buildAssessmentPrompt,
  parseAssessment,
  defaultNudge,
} from "./sentinel.js";
