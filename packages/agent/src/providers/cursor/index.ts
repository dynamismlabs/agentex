import type { ProviderModule } from "../../types.js";
import { executeCursorProvider } from "./execute.js";
import { testCursorEnvironment } from "./test.js";
import { cursorSessionCodec } from "./codec.js";

export const cursorProvider: ProviderModule = {
  type: "cursor",
  execute: executeCursorProvider,
  testEnvironment: testCursorEnvironment,
  sessionCodec: cursorSessionCodec,
};
