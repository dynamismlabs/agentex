import type { ProviderConfig, ProviderServiceTier } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { NativeTelemetryRpc } from "../../telemetry/native-rpc.js";
import { record } from "../../utils/jsonl-lines.js";
import { ServiceTierConfigurationError, serviceTierRuntimeVersion, validateServiceTier, versionAtLeast } from "../../utils/service-tier.js";

export const codexTierId = (id: string): string => id === "fast" ? "priority" : id;

export function parseCodexServiceTiers(value: unknown): ProviderServiceTier[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers: ProviderServiceTier[] = [{ id: "default", name: "Standard", availability: "available" }];
  for (const item of value) {
    const tier = record(item);
    if (!tier || typeof tier.id !== "string" || !tier.id || typeof tier.name !== "string" || !tier.name) continue;
    const id = codexTierId(tier.id);
    if (tiers.some((entry) => entry.id === id)) continue;
    tiers.push({ id, name: tier.name, ...(typeof tier.description === "string" ? { description: tier.description } : {}), availability: "unknown",
      reason: "Advertised by the model catalog; account access and capacity are enforced by Codex" });
  }
  return tiers;
}

export function codexServiceTierArgs(config: ProviderConfig, configArgs: string[]): string[] {
  const tier = validateServiceTier(config.serviceTier);
  if (tier === undefined) return [];
  // Reject ambiguous double configuration rather than letting spawn config and
  // thread/resume disagree. Profiles remain supported and are inspected below.
  for (let i = 0; i < configArgs.length; i++) {
    const arg = configArgs[i]!;
    const value = arg === "-c" || arg === "--config" ? configArgs[++i] : arg.replace(/^(?:-c|--config=)/, "");
    if (/^\s*service_tier\s*=/.test(value ?? "")) {
      const native = value!.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
      if (codexTierId(native) !== codexTierId(tier)) throw new ServiceTierConfigurationError("conflicting_settings", "config.serviceTier conflicts with extraArgs service_tier");
    }
  }
  return ["-c", `service_tier=${JSON.stringify(codexTierId(tier))}`];
}

/** Read-only preflight: no thread is created and no model request is sent. */
export async function validateCodexServiceTier(config: ProviderConfig, binary: ResolvedBinary,
  configArgs: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const tier = validateServiceTier(config.serviceTier);
  if (tier === undefined) return;
  const version = await serviceTierRuntimeVersion(binary, cwd, env, signal);
  if (!versionAtLeast(version, [0, 163, 0])) throw new ServiceTierConfigurationError("unsupported_runtime", "First-class service tiers require Codex CLI 0.163.0 or newer");
  if (tier === "default") return;
  const rpc = new NativeTelemetryRpc(binary.bin, [...binary.prefixArgs, ...configArgs, "app-server"], cwd, env, "codex", signal);
  try {
    await rpc.request("initialize", { clientInfo: { name: "agentex-speed-check", version: "1" }, capabilities: { experimentalApi: true } });
    const response = await rpc.request("config/read", { includeLayers: false });
    const native = record(response.config) ?? {};
    const feature = tier === "ultrafast" ? "ultrafast_mode" : "fast_mode";
    if (record(native.features)?.[feature] === false) throw new ServiceTierConfigurationError("unavailable", `Codex ${feature} is disabled in the selected configuration`);
  } catch (error) {
    if (error instanceof ServiceTierConfigurationError) throw error;
    throw new ServiceTierConfigurationError("discovery_failed", "Could not verify Codex service-tier availability; no inference was started");
  } finally { await rpc.close(); }
}

export function assertCodexModelTier(tier: string, model: string, entries: unknown[]): void {
  if (tier === "default") return;
  const entry = entries.map(record).find((m) => m && (m.id === model || m.model === model));
  if (!entry || !Array.isArray(entry.serviceTiers)) throw new ServiceTierConfigurationError("discovery_failed", "Cannot verify the selected model's service tiers");
  if (!entry.serviceTiers.some((value) => {
    const id = record(value)?.id;
    return typeof id === "string" && codexTierId(id) === codexTierId(tier);
  })) {
    throw new ServiceTierConfigurationError("unsupported_model", `The selected Codex model does not advertise service tier ${tier}`);
  }
}
