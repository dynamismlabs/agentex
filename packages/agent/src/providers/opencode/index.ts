import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { executeOpenCodeProvider } from "./execute.js";
import { opencodeSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { createOpenCodeSession } from "./http-session.js";

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
    modes: false,
  },
  // One-shot `opencode run` for execute(); live HTTP/SSE sessions via the
  // `opencode serve` daemon for createSession().
  execute: executeOpenCodeProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createOpenCodeSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("opencode", ctx),
  sessionCodec: opencodeSessionCodec,
};
