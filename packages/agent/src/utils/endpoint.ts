import type { ProviderEndpointConfig } from "../types.js";

/**
 * Result of translating a `ProviderEndpointConfig` into what a specific
 * provider's spawned CLI understands. Since there is no shared wire format
 * across CLIs, each provider gets its own translation:
 * - `env` is merged into the child process environment.
 * - `args` is appended to the child argv (codex `-c` config overrides).
 * - `unset` names env vars to REMOVE from the child env after merging. Env
 *   alone can't express deletion, and ambient provider credentials seeded by
 *   `buildEnv` (e.g. a real `ANTHROPIC_API_KEY` from the host `process.env`)
 *   must not leak to a third-party `baseUrl`.
 *
 * Apply order at every call site: `Object.assign(env, tx.env)` then
 * `for (const k of tx.unset) delete env[k]`.
 */
export interface EndpointTranslation {
  env: Record<string, string>;
  args: string[];
  unset: string[];
}

/** Fresh empty translation. Not a shared singleton — callers may mutate. */
function empty(): EndpointTranslation {
  return { env: {}, args: [], unset: [] };
}

/**
 * Stable id of the Codex `model_provider` synthesized for a custom endpoint.
 * Exposed so advanced Codex knobs can be set via `config.extraArgs` against a
 * known name, e.g. `-c model_providers.custom.query_params.api-version="..."`.
 */
export const CODEX_CUSTOM_PROVIDER_ID = "custom";

/** Env var Codex reads the custom-endpoint credential from (its `env_key`). */
export const CODEX_CUSTOM_KEY_ENV = "CODEX_CUSTOM_API_KEY";

/** Prefix for the per-header env vars Codex reads via `env_http_headers`. */
export const CODEX_CUSTOM_HEADER_ENV_PREFIX = "CODEX_CUSTOM_HEADER_";

/**
 * Ambient Anthropic alternate-routing env (Bedrock/Vertex/Foundry) that must be
 * cleared when a custom `baseUrl` is set — otherwise Claude Code could be steered
 * to one of those instead of the endpoint. General AWS/cloud creds are left
 * intact (the agent may legitimately need them for tool calls).
 */
const CLAUDE_ALT_ROUTING_ENV = [
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Translate a custom-endpoint config for a provider. Returns `env`/`args`/`unset`
 * to apply at spawn time. Providers without a custom-endpoint mechanism return
 * an empty translation (the config is silently ignored, like `allowedTools`
 * on providers without argv tool filtering).
 */
export function translateEndpoint(
  providerType: string,
  endpoint: ProviderEndpointConfig | undefined,
): EndpointTranslation {
  if (!endpoint) return empty();
  switch (providerType) {
    case "claude":
      return translateClaudeEndpoint(endpoint);
    case "codex":
      return translateCodexEndpoint(endpoint);
    default:
      return empty();
  }
}

/**
 * Claude Code routes to any Anthropic Messages-API-compatible endpoint purely
 * through env vars, so the translation is env-only (no argv).
 *
 * Credential hygiene: `buildEnv` seeds `ANTHROPIC_API_KEY` from the host's
 * `process.env`. When we point at a custom `baseUrl`, only the auth declared
 * here may reach that third party — so we `unset` any ambient Anthropic
 * credential we didn't choose. Without a custom `baseUrl` (still real
 * Anthropic) we only enforce the "exactly one auth" invariant.
 */
function translateClaudeEndpoint(e: ProviderEndpointConfig): EndpointTranslation {
  const env: Record<string, string> = {};
  const unset: string[] = [];
  if (e.baseUrl) env["ANTHROPIC_BASE_URL"] = e.baseUrl;
  // authToken (Authorization: Bearer) wins over apiKey (x-api-key) if both are
  // set. Whichever is NOT chosen is removed from the child env, ambient or not.
  if (e.authToken) {
    env["ANTHROPIC_AUTH_TOKEN"] = e.authToken;
    unset.push("ANTHROPIC_API_KEY");
  } else if (e.apiKey) {
    env["ANTHROPIC_API_KEY"] = e.apiKey;
    unset.push("ANTHROPIC_AUTH_TOKEN");
  } else if (e.baseUrl) {
    // Custom endpoint with no declared auth: don't forward ambient Anthropic
    // credentials to it. The caller must pass auth explicitly via the endpoint.
    unset.push("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN");
  }
  // A custom baseUrl is authoritative — clear ambient alternate-routing config
  // (Bedrock/Vertex/Foundry) so Claude Code targets the endpoint, not those.
  if (e.baseUrl) unset.push(...CLAUDE_ALT_ROUTING_ENV);
  if (e.headers && Object.keys(e.headers).length > 0) {
    // ANTHROPIC_CUSTOM_HEADERS is newline-separated `Name: Value` pairs.
    env["ANTHROPIC_CUSTOM_HEADERS"] = Object.entries(e.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  if (e.modelMap) {
    // Tier aliases → concrete ids on the endpoint. Lets alias callers
    // (`model: "sonnet"`) resolve correctly against a non-Anthropic endpoint.
    if (e.modelMap.opus) env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = e.modelMap.opus;
    if (e.modelMap.sonnet) env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = e.modelMap.sonnet;
    if (e.modelMap.haiku) env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = e.modelMap.haiku;
    if (e.modelMap.fable) env["ANTHROPIC_DEFAULT_FABLE_MODEL"] = e.modelMap.fable;
  }
  return { env, args: [], unset };
}

/**
 * Codex has no base-URL env var — custom endpoints are a `[model_providers.<id>]`
 * config block (base_url, wire_api, env_key) selected by `model_provider`. We
 * synthesize that block via `-c` overrides (the same mechanism already used for
 * `model_reasoning_effort`) and inject the key into env under `env_key`.
 *
 * `wire_api` is `"responses"`: Codex removed the Chat Completions ("chat") wire
 * protocol in Feb 2026, so a custom provider must speak the OpenAI Responses
 * API (directly or via a translating gateway). `modelMap` is ignored — Codex
 * has no tier aliases, so pass a concrete `config.model`. Requires `baseUrl`;
 * without it there is no provider to define, so the translation is empty.
 *
 * Codex needs no `unset`: ambient `OPENAI_API_KEY` is the DEFAULT provider's
 * `env_key`, and we select the synthesized `custom` provider whose `env_key`
 * is `CODEX_CUSTOM_KEY_ENV`, so the ambient key never reaches the endpoint.
 */
function translateCodexEndpoint(e: ProviderEndpointConfig): EndpointTranslation {
  if (!e.baseUrl) return empty();
  const env: Record<string, string> = {};
  const args: string[] = [];
  const id = CODEX_CUSTOM_PROVIDER_ID;
  const set = (key: string, value: string) => {
    // Match the existing `-c key=<json-value>` convention (see codex effort).
    args.push("-c", `${key}=${JSON.stringify(value)}`);
  };
  set("model_provider", id);
  set(`model_providers.${id}.name`, "Custom");
  set(`model_providers.${id}.base_url`, e.baseUrl);
  set(`model_providers.${id}.wire_api`, "responses");
  const key = e.authToken ?? e.apiKey;
  if (key) {
    env[CODEX_CUSTOM_KEY_ENV] = key;
    set(`model_providers.${id}.env_key`, CODEX_CUSTOM_KEY_ENV);
  }
  if (e.headers) {
    // Route header VALUES through env via `env_http_headers` (header → env-var
    // name), never argv: argv is world-readable via `ps` and a header can carry
    // a secret (Authorization, X-API-Key). Mirrors why the claude provider
    // stages MCP headers to a 0600 file instead of the command line. Header
    // names are assumed TOML bare keys (letters/digits/`-`/`_`), which real HTTP
    // header tokens are — a name with a `.` would nest as a sub-table.
    let i = 0;
    for (const [name, value] of Object.entries(e.headers)) {
      const headerEnv = `${CODEX_CUSTOM_HEADER_ENV_PREFIX}${i++}`;
      env[headerEnv] = value;
      set(`model_providers.${id}.env_http_headers.${name}`, headerEnv);
    }
  }
  // modelMap intentionally ignored — Codex has no tier aliases.
  return { env, args, unset: [] };
}
