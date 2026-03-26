import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv } from "../../utils/env.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testCursorEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  // Check binary resolvable
  try {
    await findBinary("agent", command);
    checks.push({
      code: "cursor_command_resolvable",
      level: "info",
      message: "Cursor agent binary is resolvable",
    });
  } catch (err) {
    checks.push({
      code: "cursor_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Cursor agent binary not found",
      hint: "Install the Cursor CLI agent and ensure it's on your PATH.",
    });
  }

  // Check API key
  const env = buildEnv(
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined,
  );
  const hasCursorKey = typeof env["CURSOR_API_KEY"] === "string" && env["CURSOR_API_KEY"].trim().length > 0;
  const hasOpenAiKey = typeof env["OPENAI_API_KEY"] === "string" && env["OPENAI_API_KEY"].trim().length > 0;

  if (hasCursorKey || hasOpenAiKey) {
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: `${hasCursorKey ? "CURSOR_API_KEY" : "OPENAI_API_KEY"} is set.`,
    });
  } else {
    checks.push({
      code: "cursor_subscription_mode",
      level: "info",
      message: "No API key set; Cursor will use subscription-based auth.",
    });
  }

  return {
    providerType: ctx.providerType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
