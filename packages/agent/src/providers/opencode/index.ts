import type { ProviderModule, SessionContext, AgentSession } from "../../types.js";
import { opencodeSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { EMULATED_GOAL_CAPABILITY } from "../../goals/index.js";

export const opencodeProvider: ProviderModule = {
  type: "opencode",
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
    goals: EMULATED_GOAL_CAPABILITY,
    durableHistory: true,
    resume: true,
    modelVariants: true,
    permissionRequests: true,
    questionRequests: true,
    upstreamProviderDisconnect: true,
    sessionModelChange: true,
    sessionVariantChange: true,
    sessionEffortChange: false,
    sessionModeChange: true,
  },
  // One-shot `opencode run` for execute(); live HTTP/SSE sessions via the
  // `opencode serve` daemon for createSession(). Both load lazily on first use.
  execute: async (ctx) => (await import("./execute.js")).executeOpenCodeProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./http-session.js")).createOpenCodeSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("opencode", ctx),
  sessionCodec: opencodeSessionCodec,
  listModels: (options) => import("./discovery.js").then((m) => m.listOpenCodeModels(options)),
  listModes: (options) => import("./modes.js").then((m) => m.listOpenCodeModes(options)),
  probeCapabilities: (ctx) => import("./probe.js").then((m) => m.probeOpenCodeCapabilities(ctx)),
  upstreamProviders: {
    list: (ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.list(ctx)),
    authMethods: (providerId, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.authMethods(providerId, ctx)),
    setApiKey: (providerId, key, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.setApiKey(providerId, key, ctx)),
    beginOAuth: (providerId, methodId, inputs, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.beginOAuth(providerId, methodId, inputs, ctx)),
    completeOAuth: (flowId, code, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.completeOAuth(flowId, code, ctx)),
    canDisconnect: (providerId, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.canDisconnect(providerId, ctx)),
    disconnect: (providerId, ctx) => import("./manager.js").then((m) => m.openCodeUpstreamProviders.disconnect(providerId, ctx)),
  },
  attachHistory: (record, options) => import("./history.js").then((m) => m.attachOpenCodeHistory(record, options)),
};
