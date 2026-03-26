import type { ProviderModule } from "../../types.js";
import { executeGeminiProvider } from "./execute.js";
import { testGeminiEnvironment } from "./test.js";
import { geminiSessionCodec } from "./codec.js";

export const geminiProvider: ProviderModule = {
  type: "gemini",
  execute: executeGeminiProvider,
  testEnvironment: testGeminiEnvironment,
  sessionCodec: geminiSessionCodec,
};
