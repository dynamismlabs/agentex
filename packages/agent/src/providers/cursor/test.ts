import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

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

  const callerEnv =
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined;
  const auth = await resolveAuthForProvider("cursor", { env: callerEnv });

  const apiKey = auth.options.find((o) => o.method === "api_key" && o.present === true);
  if (apiKey) {
    const varName = apiKey.source.kind === "env" ? apiKey.source.var : "an API key";
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: `${varName} is set.`,
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
    auth,
    checks,
    testedAt: new Date().toISOString(),
  };
}
