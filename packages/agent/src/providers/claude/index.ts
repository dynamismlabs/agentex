import type { ProviderModule, SessionContext, AgentSession, QuotaContext, QuotaStatus } from "../../types.js";
import { detectAuth, resolveAuthForProvider } from "../../utils/auth.js";
import { executeClaudeProvider } from "./execute.js";
import { createClaudeSession } from "./session.js";
import { claudeSessionCodec } from "./codec.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";

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
    instructions: true,
    workspace: true,
  },
  execute: executeClaudeProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createClaudeSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("claude", ctx),
  sessionCodec: claudeSessionCodec,
  checkQuota,
};
