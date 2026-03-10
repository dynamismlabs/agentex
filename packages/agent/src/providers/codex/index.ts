import type { ProviderModule } from "../../types.js";
import { executeCodexProvider } from "./execute.js";
import { testCodexEnvironment } from "./test.js";
import { codexSessionCodec } from "./codec.js";

export const codexProvider: ProviderModule = {
  type: "codex",
  execute: executeCodexProvider,
  testEnvironment: testCodexEnvironment,
  sessionCodec: codexSessionCodec,
};
