import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AuthOption,
  AuthReport,
  AuthResolveContext,
  ProviderModule,
} from "../types.js";
import { buildEnv } from "./env.js";

export interface ResolvedAuth {
  /** How the user is authenticated */
  method: "api_key" | "bedrock" | "oauth" | "subscription";
  /** How usage is billed */
  billingType: "api" | "metered_api" | "subscription";
  /** If the auth method requires model ID transformation (e.g., Bedrock), this resolves it */
  resolveModelId?(requestedModel: string): string;
  /** Cloud region, if applicable (Bedrock) */
  region?: string;
}

function hasEnv(env: Record<string, string>, key: string): boolean {
  const v = env[key];
  return typeof v === "string" && v.trim().length > 0;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Returns the env-scoped home directory for a provider, honoring the provider's
 * config-dir override env var (e.g. CODEX_HOME, CLAUDE_CONFIG_DIR).
 */
function providerHome(envVar: string, defaultDir: string): string {
  const override = process.env[envVar];
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), defaultDir);
}

/**
 * Map standard Claude model names to Bedrock-qualified IDs.
 * Unknown models pass through unchanged.
 */
function bedrockModelId(model: string, region?: string): string {
  const prefix = region ?? "us";
  const mapping: Record<string, string> = {
    "claude-sonnet-4-6": `${prefix}.anthropic.claude-sonnet-4-6-v1`,
    "claude-opus-4-6": `${prefix}.anthropic.claude-opus-4-6-v1`,
    "claude-haiku-4-5": `${prefix}.anthropic.claude-haiku-4-5-v1`,
    "claude-3.5-sonnet": `${prefix}.anthropic.claude-3-5-sonnet-20241022-v2:0`,
    "claude-3.5-haiku": `${prefix}.anthropic.claude-3-5-haiku-20241022-v1:0`,
  };
  return mapping[model] ?? model;
}

/**
 * Detect authentication method for a given provider based on environment variables.
 */
export function detectAuth(providerType: string, env: Record<string, string>): ResolvedAuth {
  switch (providerType) {
    case "claude": {
      // Check for Bedrock
      if (hasEnv(env, "ANTHROPIC_BEDROCK_BASE_URL") || (hasEnv(env, "AWS_ACCESS_KEY_ID") && hasEnv(env, "AWS_REGION"))) {
        const region = env["AWS_REGION"]?.trim();
        return {
          method: "bedrock",
          billingType: "metered_api",
          region,
          resolveModelId: (model: string) => bedrockModelId(model, region),
        };
      }
      // Check for API key
      if (hasEnv(env, "ANTHROPIC_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
      // Subscription fallback
      return { method: "subscription", billingType: "subscription" };
    }

    case "codex": {
      if (hasEnv(env, "OPENAI_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
      return { method: "subscription", billingType: "subscription" };
    }

    case "gemini": {
      if (hasEnv(env, "GEMINI_API_KEY") || hasEnv(env, "GOOGLE_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
      return { method: "subscription", billingType: "subscription" };
    }

    case "cursor": {
      if (hasEnv(env, "CURSOR_API_KEY") || hasEnv(env, "OPENAI_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
      return { method: "subscription", billingType: "subscription" };
    }

    case "opencode": {
      // OpenCode is typically API-based
      return { method: "api_key", billingType: "api" };
    }

    case "pi": {
      // Pi is typically API-based
      return { method: "api_key", billingType: "api" };
    }

    default:
      return { method: "subscription", billingType: "subscription" };
  }
}

// ---------------------------------------------------------------------------
// resolveAuth — structured, side-effect-free (aside from file stats) report
// of every auth path a provider supports, and which are currently present.
// ---------------------------------------------------------------------------

function envOption(
  env: Record<string, string>,
  method: AuthOption["method"],
  varName: string,
): AuthOption {
  return {
    method,
    source: { kind: "env", var: varName },
    present: hasEnv(env, varName),
  };
}

async function resolveCodexAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const options: AuthOption[] = [];

  options.push(envOption(env, "api_key", "OPENAI_API_KEY"));

  const authPath = path.join(providerHome("CODEX_HOME", ".codex"), "auth.json");
  options.push({
    method: "subscription",
    source: { kind: "file", path: authPath },
    present: await fileExists(authPath),
  });

  return { providerType: "codex", options };
}

async function resolveClaudeAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const options: AuthOption[] = [];

  options.push(envOption(env, "api_key", "ANTHROPIC_API_KEY"));

  const bedrockUrl = hasEnv(env, "ANTHROPIC_BEDROCK_BASE_URL");
  const awsCreds = hasEnv(env, "AWS_ACCESS_KEY_ID") && hasEnv(env, "AWS_REGION");
  options.push({
    method: "bedrock",
    source: {
      kind: "env_combo",
      vars: ["ANTHROPIC_BEDROCK_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_REGION"],
    },
    present: bedrockUrl || awsCreds,
  });

  if (process.platform === "darwin") {
    // macOS stores Claude Code subscription creds in the system Keychain.
    // Reading it triggers a user prompt, so we can't confirm silently.
    options.push({
      method: "subscription",
      source: { kind: "keychain", service: "Claude Code" },
      present: "unknown",
    });
  } else {
    const credPath = path.join(providerHome("CLAUDE_CONFIG_DIR", ".claude"), ".credentials.json");
    options.push({
      method: "subscription",
      source: { kind: "file", path: credPath },
      present: await fileExists(credPath),
    });
  }

  return { providerType: "claude", options };
}

async function resolveGeminiAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const options: AuthOption[] = [];

  options.push(envOption(env, "api_key", "GEMINI_API_KEY"));
  options.push(envOption(env, "api_key", "GOOGLE_API_KEY"));

  const credPath = path.join(providerHome("GEMINI_CONFIG_DIR", ".gemini"), "oauth_creds.json");
  options.push({
    method: "subscription",
    source: { kind: "file", path: credPath },
    present: await fileExists(credPath),
  });

  return { providerType: "gemini", options };
}

async function resolveCursorAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  return {
    providerType: "cursor",
    options: [
      envOption(env, "api_key", "CURSOR_API_KEY"),
      envOption(env, "api_key", "OPENAI_API_KEY"),
    ],
  };
}

async function resolveOpencodeAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  return {
    providerType: "opencode",
    options: [
      envOption(env, "api_key", "OPENAI_API_KEY"),
      envOption(env, "api_key", "ANTHROPIC_API_KEY"),
    ],
  };
}

async function resolvePiAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  return {
    providerType: "pi",
    options: [
      envOption(env, "api_key", "OPENAI_API_KEY"),
      envOption(env, "api_key", "ANTHROPIC_API_KEY"),
    ],
  };
}

/**
 * Resolve the auth report for a provider by type. Providers call the matching
 * function from their own `resolveAuth` method; callers can use the helpers
 * below (`hasSubscription`, `hasApiKey`, `hasBedrock`) instead of this
 * directly.
 */
export async function resolveAuthForProvider(
  providerType: string,
  ctx?: AuthResolveContext,
): Promise<AuthReport> {
  switch (providerType) {
    case "codex":
      return resolveCodexAuth(ctx);
    case "claude":
      return resolveClaudeAuth(ctx);
    case "gemini":
      return resolveGeminiAuth(ctx);
    case "cursor":
      return resolveCursorAuth(ctx);
    case "opencode":
      return resolveOpencodeAuth(ctx);
    case "pi":
      return resolvePiAuth(ctx);
    default:
      return { providerType, options: [] };
  }
}

// ---------------------------------------------------------------------------
// Sugar: method-specific presence checks. Each commits the caller to a
// billing mode, making the choice visible at the call site. "unknown"
// presence (e.g. macOS keychain) is NOT treated as present — safe default.
// ---------------------------------------------------------------------------

function anyPresent(report: AuthReport, method: AuthOption["method"]): boolean {
  return report.options.some((o) => o.method === method && o.present === true);
}

/** True only if a subscription credential is confirmed present on disk. */
export async function hasSubscription(
  provider: ProviderModule,
  ctx?: AuthResolveContext,
): Promise<boolean> {
  const report = await provider.resolveAuth(ctx);
  return anyPresent(report, "subscription");
}

/** True only if an API key is confirmed set in the env. */
export async function hasApiKey(
  provider: ProviderModule,
  ctx?: AuthResolveContext,
): Promise<boolean> {
  const report = await provider.resolveAuth(ctx);
  return anyPresent(report, "api_key");
}

/** True only if Bedrock credentials are confirmed present in the env. */
export async function hasBedrock(
  provider: ProviderModule,
  ctx?: AuthResolveContext,
): Promise<boolean> {
  const report = await provider.resolveAuth(ctx);
  return anyPresent(report, "bedrock");
}
