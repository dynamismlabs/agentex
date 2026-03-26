import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv } from "../../utils/env.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testOpenCodeEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  // Check binary resolvable
  try {
    await findBinary("opencode", command);
    checks.push({
      code: "opencode_command_resolvable",
      level: "info",
      message: "OpenCode binary is resolvable",
    });
  } catch (err) {
    checks.push({
      code: "opencode_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "OpenCode binary not found",
      hint: "Install OpenCode and ensure it's on your PATH.",
    });
  }

  // Check for provider API keys (OpenCode routes to various providers)
  const env = buildEnv(
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined,
  );
  const hasOpenAiKey = typeof env["OPENAI_API_KEY"] === "string" && env["OPENAI_API_KEY"].trim().length > 0;
  const hasAnthropicKey = typeof env["ANTHROPIC_API_KEY"] === "string" && env["ANTHROPIC_API_KEY"].trim().length > 0;

  if (hasOpenAiKey || hasAnthropicKey) {
    const keys = [hasOpenAiKey && "OPENAI_API_KEY", hasAnthropicKey && "ANTHROPIC_API_KEY"].filter(Boolean).join(", ");
    checks.push({
      code: "opencode_api_key_present",
      level: "info",
      message: `Provider API key(s) set: ${keys}`,
    });
  } else {
    checks.push({
      code: "opencode_api_key_missing",
      level: "warn",
      message: "No provider API keys set. OpenCode requires API keys for the configured provider.",
      hint: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY depending on your configured model.",
    });
  }

  return {
    providerType: ctx.providerType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
