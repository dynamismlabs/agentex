import type { ProviderModule } from "../../types.js";
import { executePiProvider } from "./execute.js";
import { testPiEnvironment } from "./test.js";
import { piSessionCodec } from "./codec.js";

export const piProvider: ProviderModule = {
  type: "pi",
  execute: executePiProvider,
  testEnvironment: testPiEnvironment,
  sessionCodec: piSessionCodec,
};
