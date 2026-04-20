import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

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

  const callerEnv =
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined;
  const auth = await resolveAuthForProvider("gemini", { env: callerEnv });

  const apiKey = auth.options.find(
    (o) => o.method === "api_key" && o.present === true,
  );
  const subscription = auth.options.find((o) => o.method === "subscription");

  if (apiKey) {
    const varName = apiKey.source.kind === "env" ? apiKey.source.var : "an API key";
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: `${varName} is set; Gemini will use API-key billing.`,
    });
  }

  if (subscription?.present === true) {
    checks.push({
      code: "gemini_subscription_credentials_present",
      level: "info",
      message: "Gemini login credentials detected on disk.",
    });
  }

  if (!apiKey && subscription?.present !== true) {
    checks.push({
      code: "gemini_no_auth_detected",
      level: "warn",
      message: "No Gemini authentication detected.",
      hint: "Run `gemini auth login` or set GEMINI_API_KEY / GOOGLE_API_KEY.",
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
