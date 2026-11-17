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
import type { OpenCodeClient } from "./client.js";
import { rec, v2DataRecord } from "./v2.js";

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

/**
 * The model an OpenCode 2 variant applies to when the caller named none.
 * OpenCode 2 carries the variant on the model reference (`model#variant` for
 * `opencode run`), so without a model an effort would be silently dropped.
 * This is the resumed session's own model, else the server's default for the
 * folder it runs in. Null when OpenCode reports neither.
 */
export async function resolveOpenCodeV2Model(
  client: Pick<OpenCodeClient, "json">,
  resumeId: string | null,
): Promise<{ providerID: string; id: string } | null> {
  const modelRef = (raw: unknown) => {
    const model = rec(raw);
    const providerID = typeof model["providerID"] === "string" ? model["providerID"] : "";
    const id = typeof model["id"] === "string" ? model["id"] : typeof model["modelID"] === "string" ? model["modelID"] : "";
    return providerID && id ? { providerID, id } : null;
  };
  if (resumeId) {
    // A session OpenCode no longer has is started fresh, on the default model.
    const session = await client.json<unknown>(`/api/session/${encodeURIComponent(resumeId)}`).catch(() => null);
    const current = session ? modelRef(v2DataRecord(session)["model"]) : null;
    if (current) return current;
  }
  return modelRef(v2DataRecord(await client.json<unknown>("/api/model/default")));
}

