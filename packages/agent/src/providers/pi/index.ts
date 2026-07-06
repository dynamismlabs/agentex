import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { piSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";

export const piProvider: ProviderModule = {
  type: "pi",
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
  // One-shot `pi --mode rpc` for execute(); a persistent `pi --mode rpc` process
  // across turns for createSession(). Both load lazily on first use.
  execute: async (ctx) => (await import("./execute.js")).executePiProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./session.js")).createPiSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("pi", ctx),
  sessionCodec: piSessionCodec,
};
