import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv } from "../../utils/env.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testCodexEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  // Check binary resolvable
  try {
    await findBinary("codex", command);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: "Codex binary is resolvable",
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Codex binary not found",
      hint: "Install Codex: npm install -g @openai/codex",
    });
  }

  // Check OPENAI_API_KEY
  const env = buildEnv(
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined,
  );
  const hasApiKey = typeof env["OPENAI_API_KEY"] === "string" && env["OPENAI_API_KEY"].trim().length > 0;
  if (hasApiKey) {
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set.",
    });
  } else {
    checks.push({
      code: "codex_openai_api_key_missing",
      level: "warn",
      message: "OPENAI_API_KEY is not set. Codex may require it for API auth.",
      hint: "Set OPENAI_API_KEY environment variable.",
    });
  }

  return {
    providerType: ctx.providerType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
