import type { ProviderModule } from "../../types.js";
import { executeOpenclawProvider } from "./execute.js";
import { openclawSessionCodec } from "./codec.js";

export const openclawProvider: ProviderModule = {
  type: "openclaw",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: false,
    instructions: false,
    workspace: false,
    planMode: false,
    concurrentSend: false,
    cancelQueuedMessage: false,
    stopTask: false,
    modes: false,
  },
  execute: executeOpenclawProvider,
  resolveAuth: async () => ({
    providerType: "openclaw",
    binary: { installed: true }, // openclaw is a gateway URL, not a local binary
    options: [],
    source: "filesystem",
  }),
  sessionCodec: openclawSessionCodec,
};
