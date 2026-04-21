import type { ProviderModule, ProviderModel, SessionContext, AgentSession } from "../../types.js";
import { executeCodexProvider } from "./execute.js";
import { createCodexSession } from "./session.js";
import { codexSessionCodec } from "./codec.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { ModelCache } from "../../utils/model-cache.js";
import { runChildProcess } from "../../utils/process.js";

const FALLBACK_MODELS: ProviderModel[] = [
  { id: "o3", name: "o3", provider: "openai" },
  { id: "o4-mini", name: "o4-mini", provider: "openai" },
  { id: "codex-mini-latest", name: "Codex Mini", provider: "openai" },
];

const cache = new ModelCache();

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const resolved = await findBinary("codex");
    const env = buildEnv();
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "list-models",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "models"],
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
          return { id, name: id, provider: "openai" };
        });
    }
  } catch {
    // Fallback
  }
  return FALLBACK_MODELS;
}

async function listModels(options?: { cacheTtlMs?: number }): Promise<ProviderModel[]> {
  return cache.get(options?.cacheTtlMs ?? 0, fetchModels);
}

export const codexProvider: ProviderModule = {
  type: "codex",
  capabilities: {
    sessions: true,
    modelDiscovery: true,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
  },
  execute: executeCodexProvider,
  createSession: (ctx: SessionContext): Promise<AgentSession> => createCodexSession(ctx),
  resolveAuth: (ctx) => resolveAuthForProvider("codex", ctx),
  sessionCodec: codexSessionCodec,
  listModels,
};
