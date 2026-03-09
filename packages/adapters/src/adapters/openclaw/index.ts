import type { AdapterModule } from "../../types.js";
import { executeOpenclawAdapter } from "./execute.js";
import { testOpenclawEnvironment } from "./test.js";
import { openclawSessionCodec } from "./codec.js";

export const openclawAdapter: AdapterModule = {
  type: "openclaw",
  execute: executeOpenclawAdapter,
  testEnvironment: testOpenclawEnvironment,
  sessionCodec: openclawSessionCodec,
};
