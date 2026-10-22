/**
 * Codex model discovery.
 *
 * `codex debug models` prints the CLI's own catalog as JSON, including the
 * reasoning levels each model accepts and which one it defaults to. That makes
 * Codex the one provider here whose efforts are genuinely per-model: 5.6 Sol
 * advertises `ultra`, 5.5 stops at `xhigh`, and hardcoding either answer would
 * be wrong for the other.
 */
import type { ListModelsOptions, ProviderModel } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { withModelCache } from "../../utils/model-cache.js";
import { translateEndpoint } from "../../utils/endpoint.js";
import { splitCodexExtraArgs } from "./mcp.js";
import { codexTierId, parseCodexServiceTiers } from "./service-tier.js";
import { serviceTierRuntimeVersion, versionAtLeast } from "../../utils/service-tier.js";

interface CatalogEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
  service_tiers?: unknown;
  default_service_tier?: unknown;
}

function effortList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    // Entries are objects ({ effort, description }), not bare strings.
    if (!item || typeof item !== "object") continue;
    const effort = (item as { effort?: unknown }).effort;
    if (typeof effort === "string" && effort) seen.add(effort);
  }
  return [...seen];
}

/**
 * Parse `codex debug models` output.
 *
 * Only `visibility: "list"` entries are returned. The CLI also ships hidden
 * and deprecated slugs that it will accept but does not offer, and surfacing
 * those as pickable models would be a worse catalog than no catalog.
 */
export function parseCodexModelCatalog(raw: string): ProviderModel[] {
  const parsed = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error("Codex model catalog has no models array");

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of parsed.models as CatalogEntry[]) {
    if (entry.visibility !== "list") continue;
    if (typeof entry.slug !== "string" || typeof entry.display_name !== "string") continue;
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    const supportedEfforts = effortList(entry.supported_reasoning_levels);
    const serviceTiers = parseCodexServiceTiers(entry.service_tiers);
    models.push({
      id: entry.slug,
      name: entry.display_name,
      ...(serviceTiers ? { serviceTiers } : {}),
      ...(typeof entry.default_service_tier === "string" && entry.default_service_tier ? { defaultServiceTier: codexTierId(entry.default_service_tier) } : {}),
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description.replace(/\.$/, "") }
        : {}),
      ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
      ...(typeof entry.default_reasoning_level === "string" && entry.default_reasoning_level
        ? { defaultEffort: entry.default_reasoning_level }
        : {}),
    });
  }

  if (models.length === 0) throw new Error("Codex model catalog has no visible models");
  return models;
}

export async function listCodexModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  const env = buildEnv(options.env);
  ensurePathInEnv(env);
  const endpoint = translateEndpoint("codex", options.config?.endpoint);
  Object.assign(env, endpoint.env);
  for (const key of endpoint.unset) delete env[key];
  const configArgs = [...endpoint.args, ...splitCodexExtraArgs(options.config?.extraArgs).configArgs];
  return withModelCache("codex", { ...options, env }, options.cacheTtlMs, async () => {
    const resolved = await findBinary("codex", options.config?.command);
    const result = await runChildProcess({
      runId: "codex-model-discovery",
      command: resolved.bin,
      args: [...resolved.prefixArgs, ...configArgs, "debug", "models"],
      cwd: options.cwd ?? process.cwd(),
      env,
      timeoutSec: 15,
    });
    if (result.exitCode !== 0) {
      throw new Error("The installed Codex CLI does not expose `codex debug models`");
    }
    const models = parseCodexModelCatalog(result.stdout || result.stderr);
    const version = await serviceTierRuntimeVersion(resolved, options.cwd ?? process.cwd(), env);
    const features = await runChildProcess({ runId: "codex-speed-discovery", command: resolved.bin,
      args: [...resolved.prefixArgs, ...configArgs, "features", "list"], cwd: options.cwd ?? process.cwd(), env, timeoutSec: 5, graceSec: 1 });
    if (features.exitCode === 0) {
      for (const model of models) for (const tier of model.serviceTiers ?? []) {
        const feature = tier.id === "ultrafast" ? "ultrafast_mode" : tier.id === "priority" ? "fast_mode" : null;
        if (feature && new RegExp(`^${feature}\\s+\\S+\\s+false\\s*$`, "m").test(features.stdout)) {
          tier.availability = "unavailable";
          tier.reason = `Disabled by Codex ${feature}`;
        }
      }
    }
    if (!versionAtLeast(version, [0, 163, 0])) {
      for (const model of models) for (const tier of model.serviceTiers ?? []) {
        tier.availability = version ? "unavailable" : "unknown";
        tier.reason = "First-class service tiers require a verified Codex CLI 0.163.0+ runtime";
      }
    }
    return models;
  });
}
