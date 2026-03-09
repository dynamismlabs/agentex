import type { AdapterModule, EnvironmentTestContext, EnvironmentTestResult } from "../../types.js";
import { executeProcessAdapter } from "./execute.js";
import { ensureCommandResolvable } from "../../utils/binary.js";

async function testProcessEnvironment(ctx: EnvironmentTestContext): Promise<EnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : null;

  if (!command) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [{
        code: "process_command_missing",
        level: "error",
        message: "Process adapter requires config.command to be set.",
      }],
      testedAt: new Date().toISOString(),
    };
  }

  try {
    await ensureCommandResolvable(command);
    return {
      adapterType: ctx.adapterType,
      status: "pass",
      checks: [{
        code: "process_command_resolvable",
        level: "info",
        message: `Command is resolvable: ${command}`,
      }],
      testedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [{
        code: "process_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command not found",
      }],
      testedAt: new Date().toISOString(),
    };
  }
}

export const processAdapter: AdapterModule = {
  type: "process",
  execute: executeProcessAdapter,
  testEnvironment: testProcessEnvironment,
};
