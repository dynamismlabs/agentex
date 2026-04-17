import type { ProviderModule } from "../../types.js";
import { executeOpenclawProvider } from "./execute.js";
import { testOpenclawEnvironment } from "./test.js";
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
  },
  execute: executeOpenclawProvider,
  testEnvironment: testOpenclawEnvironment,
  sessionCodec: openclawSessionCodec,
};
