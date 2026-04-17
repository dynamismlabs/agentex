import type { ProviderModule, ProviderModel } from "../../types.js";
import { executeGeminiProvider } from "./execute.js";
import { testGeminiEnvironment } from "./test.js";
import { geminiSessionCodec } from "./codec.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { ModelCache } from "../../utils/model-cache.js";
import { runChildProcess } from "../../utils/process.js";

const FALLBACK_MODELS: ProviderModel[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "google" },
];

const cache = new ModelCache();

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const resolved = await findBinary("gemini");
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
          return { id, name: id, provider: "google" };
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

export const geminiProvider: ProviderModule = {
  type: "gemini",
  capabilities: {
    sessions: false,
    modelDiscovery: true,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
  },
  execute: executeGeminiProvider,
  testEnvironment: testGeminiEnvironment,
  sessionCodec: geminiSessionCodec,
  listModels,
};
