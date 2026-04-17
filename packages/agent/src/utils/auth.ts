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
