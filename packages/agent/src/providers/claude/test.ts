import * as fs from "node:fs/promises";
import type { EnvironmentTestContext, EnvironmentTestResult, EnvironmentCheck } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { resolveAuthForProvider } from "../../utils/auth.js";
import { runChildProcess } from "../../utils/process.js";
import { parseClaudeStreamJson } from "./parse.js";

function summarizeStatus(checks: EnvironmentCheck[]): EnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testClaudeEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const checks: EnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = typeof config["command"] === "string" ? config["command"] : undefined;

  const cwd = typeof config["cwd"] === "string" ? config["cwd"] : process.cwd();
  try {
    const stat = await fs.stat(cwd);
    if (stat.isDirectory()) {
      checks.push({
        code: "claude_cwd_valid",
        level: "info",
        message: `Working directory is valid: ${cwd}`,
      });
    } else {
      checks.push({
        code: "claude_cwd_invalid",
        level: "error",
        message: `Path is not a directory: ${cwd}`,
      });
    }
  } catch {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: `Working directory does not exist: ${cwd}`,
    });
  }

  let binaryResolved = false;
  try {
    await findBinary("claude", command);
    binaryResolved = true;
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Claude binary is resolvable`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Claude binary not found",
      hint: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
    });
  }

  const callerEnv =
    typeof config["env"] === "object" && config["env"] !== null
      ? (config["env"] as Record<string, string>)
      : undefined;
  const env = buildEnv(callerEnv);
  const auth = await resolveAuthForProvider("claude", { env: callerEnv });

  const apiKey = auth.options.find(
    (o) => o.method === "api_key" && o.source.kind === "env",
  );
  const bedrock = auth.options.find((o) => o.method === "bedrock");
  const subscription = auth.options.find((o) => o.method === "subscription");

  if (bedrock?.present === true) {
    checks.push({
      code: "claude_bedrock_credentials_present",
      level: "info",
      message: "Bedrock credentials detected; Claude will use metered AWS billing.",
    });
  }

  if (apiKey?.present === true && bedrock?.present !== true) {
    // API key overrides subscription — flag as warn so the caller surfaces it.
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message: "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  }

  if (subscription?.present === true) {
    checks.push({
      code: "claude_subscription_credentials_present",
      level: "info",
      message: "Claude subscription credentials detected on disk.",
    });
  } else if (subscription?.present === "unknown") {
    checks.push({
      code: "claude_subscription_credentials_unknown",
      level: "info",
      message:
        "Claude subscription credentials are stored in the macOS Keychain and cannot be verified silently.",
    });
  }

  if (
    apiKey?.present !== true &&
    bedrock?.present !== true &&
    subscription?.present === false
  ) {
    checks.push({
      code: "claude_no_auth_detected",
      level: "warn",
      message: "No Claude authentication detected.",
      hint: "Run `claude login` for subscription auth, or set ANTHROPIC_API_KEY.",
    });
  }

  if (binaryResolved && !checks.some((c) => c.code === "claude_cwd_invalid")) {
    try {
      const resolved = await findBinary("claude", command);
      ensurePathInEnv(env);
      const proc = await runChildProcess({
        runId: `claude-envtest-${Date.now()}`,
        command: resolved.bin,
        args: [...resolved.prefixArgs, "--print", "-", "--output-format", "stream-json", "--verbose"],
        cwd,
        env,
        stdin: "Respond with hello.",
        timeoutSec: 45,
        graceSec: 5,
      });

      if (proc.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe or verify Claude can run from this directory.",
        });
      } else if ((proc.exitCode ?? 1) === 0) {
        const parsed = parseClaudeStreamJson(proc.stdout);
        const hasHello = /\bhello\b/i.test(parsed.summary ?? "");
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded."
            : "Claude probe ran but did not return 'hello' as expected.",
        });
      } else {
        checks.push({
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          hint: "Run `claude --print -` manually in this directory to debug.",
        });
      }
    } catch {
      checks.push({
        code: "claude_hello_probe_failed",
        level: "warn",
        message: "Could not run Claude hello probe.",
      });
    }
  }

  return {
    providerType: ctx.providerType,
    status: summarizeStatus(checks),
    auth,
    checks,
    testedAt: new Date().toISOString(),
  };
}
