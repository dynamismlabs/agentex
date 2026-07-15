import type { ProviderModule, SessionContext, AgentSession, QuotaContext, QuotaStatus } from "../../types.js";
import { detectAuth, resolveAuthForProvider } from "../../utils/auth.js";
import { claudeSessionCodec } from "./codec.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { claudeTranscriptOps } from "./transcript.js";
import { claudeGoalCapability } from "./goal-capability.js";

async function checkQuota(ctx: QuotaContext): Promise<QuotaStatus> {
  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  const auth = detectAuth("claude", env);
  return {
    available: auth.method !== "subscription" || !!env["ANTHROPIC_API_KEY"],
    billingType: auth.billingType,
    detail: { method: auth.method, region: auth.region },
  };
}

export const claudeProvider: ProviderModule = {
  type: "claude",
  capabilities: {
    sessions: true,
    modelDiscovery: false,
    quotaProbing: true,
    mcp: true,
    skills: true,
    skillInventory: "provider-init",
    skillInvocation: "native-slash",
    instructions: true,
    workspace: true,
    planMode: true,
    concurrentSend: true,
    cancelQueuedMessage: true,
    stopTask: true,
    backgroundTaskEvents: true,
    modes: false,
    goals: claudeGoalCapability,
    durableSessions: true,
    durableHistory: true,
    localHistory: true,
    resume: true,
    modelVariants: false,
    permissionRequests: true,
    questionRequests: true,
    strictMcpIsolation: true,
    upstreamProviderDisconnect: false,
    sessionModelChange: true,
    sessionVariantChange: false,
    sessionEffortChange: true,
    sessionModeChange: true,
  },
  // Heavy machinery (execute.ts, session.ts, attach.ts) loads lazily on first
  // use — every ProviderModule method is already async, so this is invisible to
  // callers.
  execute: async (ctx) => (await import("./execute.js")).executeClaudeProvider(ctx),
  createSession: async (ctx: SessionContext): Promise<AgentSession> =>
    (await import("./session.js")).createClaudeSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("claude", ctx),
  sessionCodec: claudeSessionCodec,
  checkQuota,
  transcript: claudeTranscriptOps,
  attachSession: async (record, opts) =>
    (await import("./attach.js")).attachClaudeSession(record, opts),
  attachHistory: async (record, opts) => {
    const [{ attachClaudeSession }, { historyFromSessionAttachment }] = await Promise.all([
      import("./attach.js"),
      import("../../sessions/history.js"),
    ]);
    return historyFromSessionAttachment("claude", await attachClaudeSession(record, opts));
  },
  localHistory: {
    probe: (options) => import("./history.js").then((module) => module.claudeLocalHistory.probe(options)),
    discover: (options) => ({
      async *[Symbol.asyncIterator]() {
        const module = await import("./history.js");
        yield* module.claudeLocalHistory.discover(options);
      },
    }),
    read: (session, options) => ({
      async *[Symbol.asyncIterator]() {
        const module = await import("./history.js");
        yield* module.claudeLocalHistory.read(session, options);
      },
    }),
    fingerprint: (session, options) => import("./history.js")
      .then((module) => module.claudeLocalHistory.fingerprint(session, options)),
  },
};

export {
  getClaudeTranscriptPath,
  findClaudeTranscriptBySessionId,
  readClaudeTranscript,
  peekClaudeTranscript,
  claudeTranscriptOps,
  sanitizeProjectPath,
  resolveClaudeHome,
  canonicalizeCwd,
  MAX_SANITIZED_LENGTH,
} from "./transcript.js";
export type {
  GetClaudeTranscriptPathOptions,
  ClaudeTranscriptLocation,
  FindClaudeTranscriptOptions,
  FoundClaudeTranscript,
  ReadClaudeTranscriptOptions,
  ClaudeTranscriptYield,
  ClaudePeekResult,
} from "./transcript.js";
