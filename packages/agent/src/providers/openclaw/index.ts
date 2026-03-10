import type { ProviderModule } from "../../types.js";
import { executeOpenclawProvider } from "./execute.js";
import { testOpenclawEnvironment } from "./test.js";
import { openclawSessionCodec } from "./codec.js";

export const openclawProvider: ProviderModule = {
  type: "openclaw",
  execute: executeOpenclawProvider,
  testEnvironment: testOpenclawEnvironment,
  sessionCodec: openclawSessionCodec,
};
