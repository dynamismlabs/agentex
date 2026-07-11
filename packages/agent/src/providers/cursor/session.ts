import type { AgentSession, SessionContext } from "../../types.js";
import { createExecBackedSession } from "../../sessions/exec-backed.js";
import { EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";
import { executeCursorProvider } from "./execute.js";
import { cursorSessionCodec } from "./codec.js";

export async function createCursorSession(ctx: SessionContext): Promise<AgentSession> {
  return createExecBackedSession({
    providerType: "cursor",
    execute: executeCursorProvider,
    sessionCodec: cursorSessionCodec,
    ctx,
    capabilities: { goals: EMULATED_GOAL_CAPABILITY },
  });
}
