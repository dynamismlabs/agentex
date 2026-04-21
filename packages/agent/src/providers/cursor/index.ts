import type { ProviderModule, ProviderModel } from "../../types.js";
import { executeCursorProvider } from "./execute.js";
import { cursorSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

const STATIC_MODELS: ProviderModel[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

async function listModels(_options?: { cacheTtlMs?: number }): Promise<ProviderModel[]> {
  return STATIC_MODELS;
}

export const cursorProvider: ProviderModule = {
  type: "cursor",
  capabilities: {
    sessions: false,
    modelDiscovery: true,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
  },
  execute: executeCursorProvider,
  resolveAuth: (ctx) => resolveAuthForProvider("cursor", ctx),
  sessionCodec: cursorSessionCodec,
  listModels,
};
