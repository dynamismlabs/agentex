import type { ProviderModule } from "../../types.js";
import { executePiProvider } from "./execute.js";
import { piSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

export const piProvider: ProviderModule = {
  type: "pi",
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
  execute: executePiProvider,
  resolveAuth: (ctx) => resolveAuthForProvider("pi", ctx),
  sessionCodec: piSessionCodec,
};
