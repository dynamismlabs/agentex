import { unsupportedSessionTelemetry } from "../../telemetry/integration.js";
import type { AgentSession, SessionContext } from "../../types.js";
import { createExecBackedSession } from "../../sessions/exec-backed.js";
import { EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";
import { executeCursorProvider } from "./execute.js";
import { cursorSessionCodec } from "./codec.js";
import { cleanupCursorSkills, prepareCursorSkills, type CursorSkills } from "./skills.js";

/**
 * Each turn is its own Cursor process. The session stages its skills once,
 * so every turn sees them at the same path (each turn copies them in fresh),
 * and removes them on close.
 */
export async function createCursorSession(ctx: SessionContext): Promise<AgentSession> {
  let skills: CursorSkills | null = null;
  try {
    skills = await prepareCursorSkills(ctx.config?.skillDirs);
  } catch {
    // Non-fatal
  }
  return unsupportedSessionTelemetry(createExecBackedSession({
    providerType: "cursor",
    execute: (execCtx) => executeCursorProvider(execCtx, skills),
    sessionCodec: cursorSessionCodec,
    ctx,
    capabilities: { goals: EMULATED_GOAL_CAPABILITY },
    onClose: () => cleanupCursorSkills(skills),
  }));
}
