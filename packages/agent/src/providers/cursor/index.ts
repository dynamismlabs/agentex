import type { AgentSession, ProviderModule, SessionContext } from "../../types.js";
import { cursorSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

export const cursorProvider: ProviderModule = {
  type: "cursor",
  capabilities: {
    sessions: true,
    modelDiscovery: true,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
    planMode: true,
    concurrentSend: false,
    cancelQueuedMessage: false,
    stopTask: false,
    modes: true,
    resume: true,
    modelVariants: false,
    permissionRequests: false,
    questionRequests: false,
    upstreamProviderDisconnect: false,
    sessionModelChange: false,
    sessionVariantChange: false,
    sessionEffortChange: false,
    sessionModeChange: false,
  },
  // execute.ts loads lazily on first use.
  execute: async (ctx) => (await import("./execute.js")).executeCursorProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./session.js")).createCursorSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("cursor", ctx),
  sessionCodec: cursorSessionCodec,
  listModels: (options) => import("./discovery.js").then((m) => m.listCursorModels(options)),
  listModes: (options) => import("./discovery.js").then((m) => m.listCursorModes(options)),
  probeCapabilities: (ctx) => import("./probe.js").then((m) => m.probeCursorCapabilities(ctx)),
};
