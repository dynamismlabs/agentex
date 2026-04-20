import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testPiEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  try {
    await findBinary("pi", command);
    checks.push({
      code: "pi_command_resolvable",
      level: "info",
      message: "Pi binary is resolvable",
    });
  } catch (err) {
    checks.push({
      code: "pi_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Pi binary not found",
      hint: "Install Pi CLI and ensure it's on your PATH.",
    });
  }

  const callerEnv =
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined;
  const auth = await resolveAuthForProvider("pi", { env: callerEnv });

  const presentKeys = auth.options
    .filter((o) => o.present === true && o.source.kind === "env")
    .map((o) => (o.source.kind === "env" ? o.source.var : ""));

  if (presentKeys.length > 0) {
    checks.push({
      code: "pi_api_key_present",
      level: "info",
      message: `Provider API key(s) set: ${presentKeys.join(", ")}`,
    });
  } else {
    checks.push({
      code: "pi_api_key_missing",
      level: "warn",
      message: "No provider API keys set. Pi requires API keys for the configured provider.",
      hint: "Set the appropriate API key for your configured provider/model.",
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
