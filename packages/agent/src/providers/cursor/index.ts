import type { ProviderModule } from "../../types.js";
import { executeCursorProvider } from "./execute.js";
import { cursorSessionCodec } from "./codec.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

export const cursorProvider: ProviderModule = {
  type: "cursor",
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
  execute: executeCursorProvider,
  resolveAuth: (ctx) => resolveAuthForProvider("cursor", ctx),
  sessionCodec: cursorSessionCodec,
};
