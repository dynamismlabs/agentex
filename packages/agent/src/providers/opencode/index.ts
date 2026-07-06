import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { opencodeSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";

export const opencodeProvider: ProviderModule = {
  type: "opencode",
  capabilities: {
    sessions: true,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
    planMode: false,
    concurrentSend: false,
    cancelQueuedMessage: false,
    stopTask: false,
    modes: false,
    goals: EMULATED_GOAL_CAPABILITY,
  },
  // One-shot `opencode run` for execute(); live HTTP/SSE sessions via the
  // `opencode serve` daemon for createSession(). Both load lazily on first use.
  execute: async (ctx) => (await import("./execute.js")).executeOpenCodeProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./http-session.js")).createOpenCodeSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("opencode", ctx),
  sessionCodec: opencodeSessionCodec,
};
