import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderConfig, ProviderServiceTier } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { record } from "../../utils/jsonl-lines.js";
import { ServiceTierConfigurationError, serviceTierRuntimeVersion, validateServiceTier, versionAtLeast } from "../../utils/service-tier.js";

export function claudeFastModel(model: string | undefined): boolean {
  const base = model?.replace(/\[1m\]$/, "");
  return base === "opus" || /^claude-opus-(?:5-5|5|4-8)(?:-\d{8})?$/.test(base ?? "");
}

function resolveFastModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const base = model?.replace(/\[1m\]$/, "");
  return base === "opus" ? env["ANTHROPIC_DEFAULT_OPUS_MODEL"] ?? base : base;
}

function fastUnavailableReason(env: Record<string, string>): string | undefined {
  const enabled = (key: string) => /^(?:1|true)$/i.test(env[key] ?? "");
  const routes = [
    ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
    ["CLAUDE_CODE_USE_MANTLE", "Amazon Bedrock Mantle"],
    ["CLAUDE_CODE_USE_VERTEX", "Google Cloud Agent Platform"],
    ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
    ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "Claude Platform on AWS"],
  ] as const;
  for (const [flag, name] of routes) {
    if (enabled(flag)) return `Claude Code Fast mode is not supported on ${name}`;
  }
  if (env["ANTHROPIC_BEDROCK_BASE_URL"] || env["ANTHROPIC_BEDROCK_MANTLE_BASE_URL"]) return "Claude Code Fast mode is not supported on Amazon Bedrock";
  if (enabled("CLAUDE_CODE_DISABLE_FAST_MODE")) return "Disabled by CLAUDE_CODE_DISABLE_FAST_MODE";
  return undefined;
}

export function claudeSettingsEnv(env: Record<string, string>, settings: Record<string, unknown>): Record<string, string> {
  const supplied = record(settings["env"]) ?? {};
  return { ...env, ...Object.fromEntries(Object.entries(supplied).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
}

export function claudeServiceTiers(model: string, version: string | null, env: Record<string, string>): ProviderServiceTier[] | undefined {
  if (!versionAtLeast(version, [2, 1, 205])) return undefined;
  const tiers: ProviderServiceTier[] = [{ id: "default", name: "Standard", availability: "available" }];
  const resolved = resolveFastModel(model, env);
  const reason = fastUnavailableReason(env);
  if (claudeFastModel(resolved)) tiers.push({ id: "fast", name: "Fast", availability: reason ? "unavailable" : "unknown",
    reason: reason ?? "Account access, organization policy, and capacity are enforced by Claude Code" });
  return tiers;
}

/** Read the CLI's final --settings value without mutating it or running hooks. */
export async function readClaudeServiceTierSettings(config: ProviderConfig, cwd: string, model?: string) {
  const original = config.extraArgs ?? [];
  const args: string[] = [];
  let settingsValue: string | undefined;
  let selectedModel = model;
  for (let i = 0; i < original.length; i++) {
    const arg = original[i]!;
    if (arg === "--settings") {
      settingsValue = original[++i];
      if (!settingsValue) throw new ServiceTierConfigurationError("conflicting_settings", "--settings requires a JSON object or file");
    } else if (arg.startsWith("--settings=")) settingsValue = arg.slice(11);
    else {
      args.push(arg);
      if (arg === "--model") selectedModel = original[i + 1];
      else if (arg.startsWith("--model=")) selectedModel = arg.slice(8);
    }
  }
  let settings: Record<string, unknown> = {};
  if (settingsValue !== undefined) {
    try {
      const raw = settingsValue.trim().startsWith("{") ? settingsValue : await readFile(resolve(cwd, settingsValue), "utf8");
      const parsed = record(JSON.parse(raw));
      if (!parsed) throw new Error("Not an object");
      settings = parsed;
    } catch { throw new ServiceTierConfigurationError("conflicting_settings", "Could not read --settings as a JSON object; no inference was started"); }
  }
  return { args, settings, selectedModel };
}

/** Preserve other settings in a private file, never copied into process argv. */
export async function prepareClaudeServiceTier(config: ProviderConfig, model: string | undefined, binary: ResolvedBinary,
  cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ args: string[]; path: string | null }> {
  const tier = validateServiceTier(config.serviceTier);
  if (tier === undefined) return { args: config.extraArgs ?? [], path: null };
  if (tier !== "fast" && tier !== "default") throw new ServiceTierConfigurationError("invalid_tier", "Claude serviceTier must be default or fast");
  const version = await serviceTierRuntimeVersion(binary, cwd, env, signal);
  if (!versionAtLeast(version, [2, 1, 205])) throw new ServiceTierConfigurationError("unsupported_runtime", "First-class service tiers require Claude Code 2.1.205 or newer");
  const { args, settings, selectedModel: override } = await readClaudeServiceTierSettings(config, cwd, model);
  const fast = tier === "fast";
  if (Object.hasOwn(settings, "fastMode") && settings["fastMode"] !== fast) throw new ServiceTierConfigurationError("conflicting_settings", "config.serviceTier conflicts with --settings fastMode");
  if (fast) {
    const effectiveEnv = claudeSettingsEnv(env, settings);
    const reason = fastUnavailableReason(effectiveEnv);
    if (reason || settings["fastModePerSessionOptIn"] === true) {
      throw new ServiceTierConfigurationError("unavailable", reason ?? "Claude Fast mode is disabled by per-session settings");
    }
    // Require an explicit choice so enabling Fast never silently upgrades Sonnet.
    const selectedModel = override ?? (typeof settings["model"] === "string" ? settings["model"] : undefined);
    const resolvedModel = resolveFastModel(selectedModel, effectiveEnv);
    if (!claudeFastModel(resolvedModel)) throw new ServiceTierConfigurationError("unsupported_model", "Claude Fast mode requires an explicit supported Opus model (for example config.model = opus)");
  }
  const dir = await mkdtemp(join(tmpdir(), "agentex-speed-"));
  const file = join(dir, "settings.json");
  try { await writeFile(file, JSON.stringify({ ...settings, fastMode: fast }), { mode: 0o600 }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { args: [...args, "--settings", file], path: file };
}
