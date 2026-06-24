import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { executePiProvider } from "./execute.js";
import { piSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { createPiSession } from "./session.js";

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
  },
  // One-shot `pi --mode rpc` for execute(); a persistent `pi --mode rpc` process
  // across turns for createSession().
  execute: executePiProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createPiSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("pi", ctx),
  sessionCodec: piSessionCodec,
};
