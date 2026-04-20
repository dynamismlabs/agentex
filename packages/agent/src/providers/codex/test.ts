import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { resolveAuthForProvider } from "../../utils/auth.js";

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

  const callerEnv =
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined;
  const auth = await resolveAuthForProvider("codex", { env: callerEnv });

  const apiKey = auth.options.find(
    (o) => o.method === "api_key" && o.source.kind === "env",
  );
  const subscription = auth.options.find((o) => o.method === "subscription");

  if (apiKey?.present === true) {
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set; Codex will use API-key billing.",
    });
  }

  if (subscription?.present === true) {
    checks.push({
      code: "codex_subscription_credentials_present",
      level: "info",
      message: "Codex login credentials detected on disk.",
    });
  }

  if (apiKey?.present !== true && subscription?.present !== true) {
    checks.push({
      code: "codex_no_auth_detected",
      level: "warn",
      message: "No Codex authentication detected.",
      hint: "Run `codex login` for subscription auth, or set OPENAI_API_KEY for API-key billing.",
    });
  }

  if (apiKey?.present === true && subscription?.present === true) {
    checks.push({
      code: "codex_api_key_overrides_subscription",
      level: "warn",
      message:
        "Both OPENAI_API_KEY and subscription credentials are present. Codex will use the API key (metered billing).",
      hint: "Unset OPENAI_API_KEY if you intended to use subscription-based auth.",
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
