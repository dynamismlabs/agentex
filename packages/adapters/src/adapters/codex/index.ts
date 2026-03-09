import type { AdapterModule } from "../../types.js";
import { executeCodexAdapter } from "./execute.js";
import { testCodexEnvironment } from "./test.js";
import { codexSessionCodec } from "./codec.js";

export const codexAdapter: AdapterModule = {
  type: "codex",
  execute: executeCodexAdapter,
  testEnvironment: testCodexEnvironment,
  sessionCodec: codexSessionCodec,
};
