import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv } from "../../utils/env.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testGeminiEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  // Check binary resolvable
  try {
    await findBinary("gemini", command);
    checks.push({
      code: "gemini_command_resolvable",
      level: "info",
      message: "Gemini binary is resolvable",
    });
  } catch (err) {
    checks.push({
      code: "gemini_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Gemini binary not found",
      hint: "Install the Gemini CLI and ensure it's on your PATH.",
    });
  }

  // Check API key
  const env = buildEnv(
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined,
  );
  const hasGeminiKey = typeof env["GEMINI_API_KEY"] === "string" && env["GEMINI_API_KEY"].trim().length > 0;
  const hasGoogleKey = typeof env["GOOGLE_API_KEY"] === "string" && env["GOOGLE_API_KEY"].trim().length > 0;

  if (hasGeminiKey || hasGoogleKey) {
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: `${hasGeminiKey ? "GEMINI_API_KEY" : "GOOGLE_API_KEY"} is set.`,
    });
  } else {
    checks.push({
      code: "gemini_api_key_missing",
      level: "info",
      message: "No API key set; Gemini will use login-based auth if available.",
    });
  }

  return {
    providerType: ctx.providerType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
