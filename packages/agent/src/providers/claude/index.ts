import type { ProviderModule, ProviderModel, SessionContext, AgentSession, QuotaContext, QuotaStatus } from "../../types.js";
import { detectAuth } from "../../utils/auth.js";
import { executeClaudeProvider } from "./execute.js";
import { createClaudeSession } from "./session.js";
import { testClaudeEnvironment } from "./test.js";
import { claudeSessionCodec } from "./codec.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { ModelCache } from "../../utils/model-cache.js";
import { runChildProcess } from "../../utils/process.js";

const FALLBACK_MODELS: ProviderModel[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic" },
  { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", provider: "anthropic" },
];

const cache = new ModelCache();

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const resolved = await findBinary("claude");
    const env = buildEnv();
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "list-models",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "--list-models"],
      cwd: process.cwd(),
      env,
      timeoutSec: 10,
    });

    if ((proc.exitCode ?? 1) === 0 && proc.stdout.trim()) {
      return proc.stdout
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const id = line.trim();
          return { id, name: id, provider: "anthropic" };
        });
    }
  } catch {
    // Fallback to hardcoded list
  }
  return FALLBACK_MODELS;
}

async function listModels(options?: { cacheTtlMs?: number }): Promise<ProviderModel[]> {
  const ttl = options?.cacheTtlMs ?? 0;
  return cache.get(ttl, fetchModels);
}

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
    modelDiscovery: true,
    quotaProbing: true,
    mcp: true,
    skills: true,
    instructions: true,
    workspace: true,
  },
  execute: executeClaudeProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createClaudeSession(ctx),
  testEnvironment: testClaudeEnvironment,
  sessionCodec: claudeSessionCodec,
  listModels,
  checkQuota,
};
