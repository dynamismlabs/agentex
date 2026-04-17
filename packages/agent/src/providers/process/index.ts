import type { ProviderModule, EnvironmentTestContext, EnvironmentTestResult } from "../../types.js";
import { executeProcessProvider } from "./execute.js";
import { ensureCommandResolvable } from "../../utils/binary.js";

async function testProcessEnvironment(ctx: EnvironmentTestContext): Promise<EnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : null;

  if (!command) {
    return {
      providerType: ctx.providerType,
      status: "fail",
      checks: [{
        code: "process_command_missing",
        level: "error",
        message: "Process provider requires config.command to be set.",
      }],
      testedAt: new Date().toISOString(),
    };
  }

  try {
    await ensureCommandResolvable(command);
    return {
      providerType: ctx.providerType,
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
      providerType: ctx.providerType,
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

export const processProvider: ProviderModule = {
  type: "process",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: false,
    instructions: true,
    workspace: true,
  },
  execute: executeProcessProvider,
  testEnvironment: testProcessEnvironment,
};
