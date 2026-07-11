import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AuthIdentity,
  AuthOption,
  AuthReport,
  AuthResolveContext,
  BinaryStatus,
  ProviderModule,
} from "../types.js";
import { buildEnv, ensurePathInEnv } from "./env.js";
import { findBinary } from "./binary.js";
import { runChildProcess } from "./process.js";

// ---------------------------------------------------------------------------
// Legacy env-only billing classifier — kept for ExecutionResult.billingType
// prediction. Do not use for new code; prefer resolveAuthForProvider.
// ---------------------------------------------------------------------------

export interface ResolvedAuth {
  method: "api_key" | "bedrock" | "oauth" | "subscription";
  billingType: "api" | "metered_api" | "subscription";
  resolveModelId?(requestedModel: string): string;
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

function providerHome(envVar: string, defaultDir: string): string {
  const override = process.env[envVar];
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), defaultDir);
}

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

export function detectAuth(providerType: string, env: Record<string, string>): ResolvedAuth {
  switch (providerType) {
    case "claude": {
      if (hasEnv(env, "ANTHROPIC_BEDROCK_BASE_URL") || (hasEnv(env, "AWS_ACCESS_KEY_ID") && hasEnv(env, "AWS_REGION"))) {
        const region = env["AWS_REGION"]?.trim();
        return {
          method: "bedrock",
          billingType: "metered_api",
          region,
          resolveModelId: (model: string) => bedrockModelId(model, region),
        };
      }
      if (hasEnv(env, "ANTHROPIC_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
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
      if (hasEnv(env, "CURSOR_API_KEY")) {
        return { method: "api_key", billingType: "api" };
      }
      return { method: "subscription", billingType: "subscription" };
    }
    case "opencode":
    case "pi":
      return { method: "api_key", billingType: "api" };
    default:
      return { method: "subscription", billingType: "subscription" };
  }
}

// ---------------------------------------------------------------------------
// Binary status probe — spawns `<cli> --version` to populate BinaryStatus.
// ---------------------------------------------------------------------------

async function checkBinary(
  name: string,
  configOverride: string | undefined,
  env: Record<string, string>,
): Promise<BinaryStatus & { prefixArgs: string[] }> {
  let resolved;
  try {
    resolved = await findBinary(name, configOverride);
  } catch (err) {
    return {
      installed: false,
      prefixArgs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let version: string | undefined;
  try {
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "check-binary",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "--version"],
      cwd: process.cwd(),
      env,
      timeoutSec: 5,
    });
    if (proc.exitCode === 0) {
      const out = (proc.stdout || proc.stderr).trim();
      const match = out.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/);
      version = match ? match[0] : (out.split(/\s+/)[0] || undefined);
    }
  } catch {
    // Version detection is best-effort; binary is still "installed" if findBinary succeeded.
  }

  return {
    installed: true,
    resolvedPath: resolved.bin,
    prefixArgs: resolved.prefixArgs,
    version,
  };
}

// ---------------------------------------------------------------------------
// Claude — `claude auth status --json`
// ---------------------------------------------------------------------------

interface ClaudeAuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;        // e.g. "claude.ai", "api_key", "bedrock"
  apiProvider?: string;       // e.g. "firstParty", "bedrock", "vertex", "foundry"
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;  // e.g. "max", "pro", "team", "enterprise"
}

function classifyClaudeAuthMethod(raw: string | undefined): "subscription" | "api_key" | "bedrock" | null {
  if (!raw) return null;
  const m = raw.toLowerCase();
  if (m.includes("bedrock") || m.includes("vertex") || m.includes("foundry")) return "bedrock";
  if (m.includes("claude.ai") || m.includes("oauth") || m.includes("subscription")) return "subscription";
  if (m.includes("api") || m.includes("console")) return "api_key";
  return null;
}

async function resolveClaudeAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("claude", ctx?.command, env);

  const apiKeyOption: AuthOption = {
    method: "api_key",
    source: { kind: "env", var: "ANTHROPIC_API_KEY" },
    present: hasEnv(env, "ANTHROPIC_API_KEY"),
  };
  const bedrockPresent =
    hasEnv(env, "ANTHROPIC_BEDROCK_BASE_URL") ||
    (hasEnv(env, "AWS_ACCESS_KEY_ID") && hasEnv(env, "AWS_REGION"));
  const bedrockOption: AuthOption = {
    method: "bedrock",
    source: {
      kind: "env_combo",
      vars: ["ANTHROPIC_BEDROCK_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_REGION"],
    },
    present: bedrockPresent,
  };

  // Binary missing → fall back to filesystem/keychain heuristic.
  if (!binary.installed) {
    const subOption: AuthOption = process.platform === "darwin"
      ? {
          method: "subscription",
          source: { kind: "keychain", service: "Claude Code" },
          present: false, // can't verify without binary
        }
      : await (async () => {
          const credPath = path.join(
            providerHome("CLAUDE_CONFIG_DIR", ".claude"),
            ".credentials.json",
          );
          return {
            method: "subscription" as const,
            source: { kind: "file" as const, path: credPath },
            present: await fileExists(credPath),
          };
        })();
    return {
      providerType: "claude",
      binary: stripPrefixArgs(binary),
      options: [apiKeyOption, bedrockOption, subOption],
      source: "filesystem",
    };
  }

  // Binary present — try `claude auth status --json`.
  try {
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "claude-auth-status",
      command: binary.resolvedPath!,
      args: [...binary.prefixArgs, "auth", "status", "--json"],
      cwd: process.cwd(),
      env,
      timeoutSec: 10,
    });

    if (proc.exitCode === 0 && proc.stdout.trim()) {
      const data: ClaudeAuthStatusJson = JSON.parse(proc.stdout);
      const active = classifyClaudeAuthMethod(data.authMethod);
      const loggedIn = data.loggedIn === true;

      const subPresent = loggedIn && (active === "subscription" || active === null);
      const subOption: AuthOption = {
        method: "subscription",
        source: { kind: "cli", command: "claude auth status --json" },
        present: subPresent,
      };

      // Identity
      const identity: AuthIdentity = {};
      if (data.email) identity.email = data.email;
      if (data.orgName) identity.orgName = data.orgName;
      if (data.subscriptionType) identity.subscriptionType = data.subscriptionType;
      if (data.authMethod) identity.authMethod = data.authMethod;

      return {
        providerType: "claude",
        binary: stripPrefixArgs(binary),
        options: [apiKeyOption, bedrockOption, subOption],
        identity: Object.keys(identity).length > 0 ? identity : undefined,
        source: "cli",
      };
    }
  } catch {
    // fall through to filesystem
  }

  // CLI call failed (old version, parse error, etc). Fall back to filesystem.
  const subOption: AuthOption = process.platform === "darwin"
    ? {
        method: "subscription",
        source: { kind: "keychain", service: "Claude Code" },
        present: false,
      }
    : await (async () => {
        const credPath = path.join(
          providerHome("CLAUDE_CONFIG_DIR", ".claude"),
          ".credentials.json",
        );
        return {
          method: "subscription" as const,
          source: { kind: "file" as const, path: credPath },
          present: await fileExists(credPath),
        };
      })();

  return {
    providerType: "claude",
    binary: stripPrefixArgs(binary),
    options: [apiKeyOption, bedrockOption, subOption],
    source: "filesystem",
  };
}

// ---------------------------------------------------------------------------
// Codex — `codex login status`. Text-only output; regex with multiple
// tolerant patterns + filesystem fallback for forward-compat.
// ---------------------------------------------------------------------------

const CODEX_SUBSCRIPTION_PATTERNS: RegExp[] = [
  /logged\s+in\s+using\s+chatgpt/i,
  /logged\s+in\s+with\s+chatgpt/i,
  /authenticated\s+via\s+chatgpt/i,
  /signed\s+in.*chatgpt/i,
  /using\s+subscription/i,
];
const CODEX_API_KEY_PATTERNS: RegExp[] = [
  /logged\s+in\s+using\s+(an?\s+)?api[-_ ]?key/i,
  /logged\s+in\s+with\s+(an?\s+)?api[-_ ]?key/i,
  /authenticated\s+via\s+api[-_ ]?key/i,
  /signed\s+in.*api[-_ ]?key/i,
];
const CODEX_NOT_LOGGED_IN_PATTERNS: RegExp[] = [
  /not\s+logged\s+in/i,
  /not\s+authenticated/i,
  /please\s+(run\s+)?`?codex\s+login`?/i,
  /no\s+authentication/i,
];

async function resolveCodexAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("codex", ctx?.command, env);

  const apiKeyOption: AuthOption = {
    method: "api_key",
    source: { kind: "env", var: "OPENAI_API_KEY" },
    present: hasEnv(env, "OPENAI_API_KEY"),
  };
  const authPath = path.join(providerHome("CODEX_HOME", ".codex"), "auth.json");

  if (!binary.installed) {
    const subPresent = await fileExists(authPath);
    return {
      providerType: "codex",
      binary: stripPrefixArgs(binary),
      options: [
        apiKeyOption,
        {
          method: "subscription",
          source: { kind: "file", path: authPath },
          present: subPresent,
        },
      ],
      source: "filesystem",
    };
  }

  let subscriptionPresent = false;
  let activeAuthMethod: string | undefined;
  let usedCli = false;

  try {
    ensurePathInEnv(env);
    const proc = await runChildProcess({
      runId: "codex-login-status",
      command: binary.resolvedPath!,
      args: [...binary.prefixArgs, "login", "status"],
      cwd: process.cwd(),
      env,
      timeoutSec: 10,
    });

    const out = `${proc.stdout}\n${proc.stderr}`.trim();

    if (CODEX_SUBSCRIPTION_PATTERNS.some((r) => r.test(out))) {
      subscriptionPresent = true;
      activeAuthMethod = "chatgpt";
      usedCli = true;
    } else if (CODEX_API_KEY_PATTERNS.some((r) => r.test(out))) {
      // API key is the active auth; subscription status unknown from this output alone.
      // Trust the filesystem to know if a subscription is ALSO stored.
      subscriptionPresent = await fileExists(authPath);
      activeAuthMethod = "api_key";
      usedCli = true;
    } else if (CODEX_NOT_LOGGED_IN_PATTERNS.some((r) => r.test(out))) {
      subscriptionPresent = false;
      usedCli = true;
    } else {
      // Unknown wording (forward-compat) — fall back to filesystem.
      subscriptionPresent = await fileExists(authPath);
    }
  } catch {
    subscriptionPresent = await fileExists(authPath);
  }

  return {
    providerType: "codex",
    binary: stripPrefixArgs(binary),
    options: [
      apiKeyOption,
      {
        method: "subscription",
        source: usedCli
          ? { kind: "cli", command: "codex login status" }
          : { kind: "file", path: authPath },
        present: subscriptionPresent,
      },
    ],
    identity: activeAuthMethod ? { authMethod: activeAuthMethod } : undefined,
    source: usedCli ? "cli" : "filesystem",
  };
}

// ---------------------------------------------------------------------------
// Gemini — filesystem-only (no `gemini auth status` subcommand exists).
// Still runs `gemini --version` to populate BinaryStatus.
// ---------------------------------------------------------------------------

async function resolveGeminiAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("gemini", ctx?.command, env);

  const credPath = path.join(providerHome("GEMINI_CONFIG_DIR", ".gemini"), "oauth_creds.json");
  return {
    providerType: "gemini",
    binary: stripPrefixArgs(binary),
    options: [
      {
        method: "api_key",
        source: { kind: "env", var: "GEMINI_API_KEY" },
        present: hasEnv(env, "GEMINI_API_KEY"),
      },
      {
        method: "api_key",
        source: { kind: "env", var: "GOOGLE_API_KEY" },
        present: hasEnv(env, "GOOGLE_API_KEY"),
      },
      {
        method: "subscription",
        source: { kind: "file", path: credPath },
        present: await fileExists(credPath),
      },
    ],
    source: "filesystem",
  };
}

// ---------------------------------------------------------------------------
// Cursor uses its selected binary's `status` command. Other providers in this
// section use environment or native-store presence reports.
// ---------------------------------------------------------------------------

async function resolveCursorAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("agent", ctx?.command, env);
  const apiKey = {
    method: "api_key" as const,
    source: { kind: "env" as const, var: "CURSOR_API_KEY" },
    present: hasEnv(env, "CURSOR_API_KEY"),
  };
  let nativePresent = false;
  let usedCli = false;
  if (binary.installed && binary.resolvedPath) {
    try {
      const result = await runChildProcess({
        runId: "cursor-auth-status",
        command: binary.resolvedPath,
        args: [...binary.prefixArgs, "status"],
        cwd: process.cwd(),
        env,
        timeoutSec: 10,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      nativePresent = result.exitCode === 0 && /logged\s+in|authenticated|account\s*:/i.test(output)
        && !/not\s+logged\s+in|unauthenticated/i.test(output);
      usedCli = true;
    } catch {
      // Presence remains unknown and false for an unsupported old binary.
    }
  }
  return {
    providerType: "cursor",
    binary: stripPrefixArgs(binary),
    options: [
      apiKey,
      {
        method: "subscription",
        source: { kind: "cli", command: "agent status" },
        present: nativePresent,
      },
    ],
    source: usedCli ? "cli" : "filesystem",
  };
}

async function resolveOpencodeAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("opencode", ctx?.command, env);
  return {
    providerType: "opencode",
    binary: stripPrefixArgs(binary),
    options: [
      { method: "api_key", source: { kind: "env", var: "OPENAI_API_KEY" }, present: hasEnv(env, "OPENAI_API_KEY") },
      { method: "api_key", source: { kind: "env", var: "ANTHROPIC_API_KEY" }, present: hasEnv(env, "ANTHROPIC_API_KEY") },
    ],
    source: "filesystem",
  };
}

async function resolvePiAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  const env = buildEnv(ctx?.env);
  const binary = await checkBinary("pi", ctx?.command, env);
  return {
    providerType: "pi",
    binary: stripPrefixArgs(binary),
    options: [
      { method: "api_key", source: { kind: "env", var: "OPENAI_API_KEY" }, present: hasEnv(env, "OPENAI_API_KEY") },
      { method: "api_key", source: { kind: "env", var: "ANTHROPIC_API_KEY" }, present: hasEnv(env, "ANTHROPIC_API_KEY") },
    ],
    source: "filesystem",
  };
}

function stripPrefixArgs(b: BinaryStatus & { prefixArgs: string[] }): BinaryStatus {
  const { prefixArgs: _prefixArgs, ...rest } = b;
  return rest;
}

// ---------------------------------------------------------------------------
// Dispatcher + 60s cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { report: AuthReport; ts: number }>();

function cacheKey(providerType: string, ctx?: AuthResolveContext): string {
  const envKey = ctx?.env ? JSON.stringify(ctx.env) : "";
  const cmdKey = ctx?.command ?? "";
  return `${providerType}|${envKey}|${cmdKey}`;
}

async function resolveInternal(providerType: string, ctx?: AuthResolveContext): Promise<AuthReport> {
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
      return {
        providerType,
        binary: { installed: false, error: `No auth resolver for provider "${providerType}"` },
        options: [],
        source: "filesystem",
      };
  }
}

/**
 * Resolve the auth report for a provider by type. Cached for 60s per
 * (providerType, env, command). Pass `{ fresh: true }` to bypass the cache.
 */
export async function resolveAuthForProvider(
  providerType: string,
  ctx?: AuthResolveContext,
): Promise<AuthReport> {
  if (!ctx?.fresh) {
    const key = cacheKey(providerType, ctx);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return hit.report;
    }
  }

  const report = await resolveInternal(providerType, ctx);

  const key = cacheKey(providerType, ctx);
  cache.set(key, { report, ts: Date.now() });
  return report;
}

/** Clear the resolveAuth cache. Primarily for tests and explicit refresh. */
export function clearAuthCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Sugar: method-specific presence checks. Each commits the caller to a
// billing mode, making the choice visible at the call site.
// ---------------------------------------------------------------------------

function anyPresent(report: AuthReport, method: AuthOption["method"]): boolean {
  return report.options.some((o) => o.method === method && o.present === true);
}

/** True only if a subscription credential is confirmed present. */
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

// ---------------------------------------------------------------------------
// Top-level convenience: "is the user logged in?" + "what command should I
// surface in a re-auth banner?". Pair these with the StreamEvent
// `auth_required` to drive a complete login UX from a host application.
// ---------------------------------------------------------------------------

/**
 * Shell command a host should surface when an `auth_required` event fires
 * for `providerType`, or when `isLoggedIn` returns false. Values are the
 * provider's canonical CLI subcommand for interactive login — they spawn
 * a browser flow (Claude, Codex, Gemini, Cursor) or print API-key setup
 * instructions (OpenCode, Pi).
 *
 * Unknown provider types fall back to `${providerType} login`, which is
 * intentionally guess-y: if a new provider is added without updating this
 * function, the host gets a plausible string instead of a thrown error.
 */
export function loginCommandFor(providerType: string): string {
  switch (providerType) {
    case "claude":
      return "claude auth login";
    case "codex":
      return "codex login";
    case "gemini":
      // Gemini CLI uses `gemini` interactive mode for OAuth + `/auth` slash
      // command; there's no top-level `gemini auth login` subcommand. The
      // closest non-interactive path is launching `gemini` itself, which
      // triggers an OAuth flow on first run.
      return "gemini";
    case "cursor":
      return "cursor-agent login";
    case "opencode":
      return "opencode auth login";
    case "pi":
      // pi-coding-agent uses env-var auth (OPENAI_API_KEY / ANTHROPIC_API_KEY);
      // there's no login subcommand. Tell the user to set the env var.
      return "export OPENAI_API_KEY=... or ANTHROPIC_API_KEY=...";
    default:
      return `${providerType} login`;
  }
}

/**
 * Returns true when the provider has at least one credential confirmed
 * present (any of api_key, bedrock, subscription). Wraps
 * `resolveAuthForProvider` for callers that just want a yes/no.
 *
 * For Claude, this honors `claude auth status --json` (the authoritative
 * source) via the existing `resolveAuth` path — the binary is consulted
 * first and the keychain/file fallback is used only when the binary is
 * missing or its status subcommand fails.
 *
 * Note: this is a snapshot of credential *presence*, not validity. A
 * present but expired OAuth token still returns true here, because the
 * status CLI itself reports `loggedIn: true` until the next refresh
 * attempt fails. The definitive "is this credential actually accepted by
 * the API?" check happens at request time and surfaces as an
 * `auth_required` StreamEvent — pair the two:
 *
 * 1. Call `isLoggedIn` before starting a session to short-circuit
 *    obvious "never logged in" cases.
 * 2. Listen for `auth_required` events during the session to catch
 *    tokens that were valid at presence-check time but expired/revoked
 *    in flight.
 */
export async function isLoggedIn(
  providerType: string,
  ctx?: AuthResolveContext,
): Promise<boolean> {
  const report = await resolveAuthForProvider(providerType, ctx);
  return report.options.some((o) => o.present);
}
