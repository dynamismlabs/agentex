import type { ProviderModule } from "../../types.js";
import { executeOpenCodeProvider } from "./execute.js";
import { opencodeSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

export const opencodeProvider: ProviderModule = {
  type: "opencode",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: true,
    instructions: true,
    workspace: true,
    planMode: false,
    concurrentSend: false,
    cancelQueuedMessage: false,
  },
  execute: executeOpenCodeProvider,
  resolveAuth: (ctx) => resolveAuthForProvider("opencode", ctx),
  sessionCodec: opencodeSessionCodec,
};
