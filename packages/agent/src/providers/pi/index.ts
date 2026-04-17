import type { ProviderModule, ProviderModel } from "../../types.js";
import { executePiProvider } from "./execute.js";
import { testPiEnvironment } from "./test.js";
import { piSessionCodec } from "./codec.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { ModelCache } from "../../utils/model-cache.js";
import { runChildProcess } from "../../utils/process.js";

const FALLBACK_MODELS: ProviderModel[] = [
  { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "openai" },
];

const cache = new ModelCache();

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const resolved = await findBinary("pi");
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
        .filter((line) => line.trim() && !line.startsWith("---") && !line.startsWith("PROVIDER"))
        .map((line) => {
          const parts = line.trim().split(/\s{2,}/);
          const provider = parts[0]?.trim();
          const model = parts[1]?.trim();
          const id = provider && model ? `${provider}/${model}` : line.trim();
          return { id, name: model ?? id, provider };
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

export const piProvider: ProviderModule = {
  type: "pi",
  capabilities: {
    sessions: false,
    modelDiscovery: true,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
  },
  execute: executePiProvider,
  testEnvironment: testPiEnvironment,
  sessionCodec: piSessionCodec,
  listModels,
};
