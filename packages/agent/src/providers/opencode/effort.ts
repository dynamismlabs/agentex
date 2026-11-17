/**
 * Reasoning effort for OpenCode.
 *
 * OpenCode has no effort flag. Each reasoning model lists its effort levels as
 * model variants named after them, and each such variant only sets that
 * effort (OpenCode 2.3.0: Anthropic's `{ id: "high", settings: { effort:
 * "high" } }`, OpenAI-style `{ id: "minimal", settings: { reasoningEffort:
 * "minimal" } }`). A person can also define variants of their own in
 * opencode.json, and those can mean anything.
 *
 * So the effort-named variants are presented on the shared effort scale:
 * discovery reports them as `supportedEfforts` and keeps only the other
 * variants in `variants`, and `config.effort` reaches OpenCode as the variant.
 * Callers use one effort setting for every provider, and `modelVariant` stays
 * for a variant that isn't an effort level. When both are set, `modelVariant`
 * wins: OpenCode takes one variant per message.
 */
import type { ProviderConfig, ProviderModel } from "../../types.js";

/** Variant ids that are effort levels, weakest to strongest, in the shared vocabulary. */
export const OPENCODE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const RANK = new Map<string, number>(OPENCODE_EFFORTS.map((effort, index) => [effort, index]));

export function isOpenCodeEffort(id: string): boolean {
  return RANK.has(id);
}

type ModelVariant = NonNullable<ProviderModel["variants"]>[number];

/**
 * Split a model's variants into its effort levels and the rest. A disabled
 * level is not offered. A default variant that is an effort level becomes the
 * model's `defaultEffort`.
 */
export function splitOpenCodeVariants(variants: ModelVariant[]): Pick<ProviderModel, "variants" | "supportedEfforts" | "defaultEffort"> {
  const efforts = variants.filter((variant) => isOpenCodeEffort(variant.id));
  const others = variants.filter((variant) => !isOpenCodeEffort(variant.id));
  const supportedEfforts = [...new Set(efforts.filter((variant) => !variant.disabled).map((variant) => variant.id))]
    .sort((a, b) => RANK.get(a)! - RANK.get(b)!);
  const defaultEffort = efforts.find((variant) => variant.isDefault && !variant.disabled)?.id;
  return {
    ...(others.length ? { variants: others } : {}),
    ...(supportedEfforts.length ? { supportedEfforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

/** The variant a session or run sends: `modelVariant`, else the effort. */
export function openCodeVariant(config: Pick<ProviderConfig, "modelVariant" | "effort"> | undefined): string | undefined {
  return config?.modelVariant || config?.effort || undefined;
}
