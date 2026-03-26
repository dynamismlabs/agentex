import type { ProviderModule } from "../../types.js";
import { executeOpenCodeProvider } from "./execute.js";
import { testOpenCodeEnvironment } from "./test.js";
import { opencodeSessionCodec } from "./codec.js";

export const opencodeProvider: ProviderModule = {
  type: "opencode",
  execute: executeOpenCodeProvider,
  testEnvironment: testOpenCodeEnvironment,
  sessionCodec: opencodeSessionCodec,
};
