import type { AgentSession, ProviderModule, SessionContext } from "../../types.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { antigravitySessionCodec } from "./codec.js";

/**
 * Google Antigravity CLI (`agy`), the successor to Gemini CLI for Google
 * accounts (Free, AI Pro, AI Ultra) since Gemini CLI stopped serving them on
 * 2026-06-18. Driven through its headless `stream-json` mode, which keeps one
 * process per session and resumes conversations with `--conversation`.
 *
 * Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`,
 * then run `agy` once to sign in. Headless runs reuse the cached sign-in.
 */
export const antigravityProvider: ProviderModule = {
  type: "antigravity",
  capabilities: {
    sessions: true,
    modelDiscovery: true,
    quotaProbing: false,
    contextUsage: false,
    rateLimits: false,
    contextUsageRefresh: false,
    rateLimitsRefresh: false,
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
  // Everything below loads lazily on first use.
  execute: async (ctx) => (await import("./execute.js")).executeAntigravityProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./session.js")).createAntigravitySession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("antigravity", ctx),
  sessionCodec: antigravitySessionCodec,
  listModels: (options) => import("./discovery.js").then((m) => m.listAntigravityModels(options)),
  listModes: (options) => import("./discovery.js").then((m) => m.listAntigravityModes(options)),
  probeCapabilities: (ctx) => import("./probe.js").then((m) => m.probeAntigravityCapabilities(ctx)),
};
