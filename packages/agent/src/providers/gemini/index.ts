import type { ProviderModule } from "../../types.js";
import { executeGeminiProvider } from "./execute.js";
import { geminiSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

export const geminiProvider: ProviderModule = {
  type: "gemini",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
    planMode: false,
  },
  execute: executeGeminiProvider,
  resolveAuth: (ctx) => resolveAuthForProvider("gemini", ctx),
  sessionCodec: geminiSessionCodec,
};
