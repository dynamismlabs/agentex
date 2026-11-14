import type { ListModelsOptions, ProviderModel } from "../../types.js";
import { acquireOpenCodeRuntime } from "./runtime.js";
import { rec, serverApiVersion, v2DataArray } from "./v2.js";
import { withModelCache } from "../../utils/model-cache.js";

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseVariants(rawVariants: unknown) {
  if (Array.isArray(rawVariants)) {
    return rawVariants
      .map((entry) => {
        const variant = rec(entry);
        const id = typeof variant["id"] === "string" ? variant["id"] : "";
        if (!id) return null;
        return {
          id,
          name: typeof variant["name"] === "string" ? variant["name"] : id,
          ...(typeof variant["description"] === "string" ? { description: variant["description"] } : {}),
          ...(variant["disabled"] === true ? { disabled: true } : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }
  return Object.entries(rec(rawVariants)).map(([id, rawVariant]) => {
    const variant = rec(rawVariant);
    return {
      id,
      name: typeof variant["name"] === "string" ? variant["name"] : id,
      ...(typeof variant["description"] === "string" ? { description: variant["description"] } : {}),
      ...(variant["disabled"] === true ? { disabled: true } : {}),
    };
  });
}

export function openCodeModelsFromPayload(payload: Record<string, unknown>): ProviderModel[] {
  const providers = Array.isArray(payload["all"]) ? payload["all"] : [];
  const models: ProviderModel[] = [];
  for (const rawProvider of providers) {
    const provider = rec(rawProvider);
    const providerId = typeof provider["id"] === "string" ? provider["id"] : "";
    const providerName = typeof provider["name"] === "string" ? provider["name"] : providerId;
    if (!providerId) continue;
    for (const [key, rawModel] of Object.entries(rec(provider["models"]))) {
      const model = rec(rawModel);
      const modelId = typeof model["id"] === "string" ? model["id"] : key;
      if (!modelId) continue;
      const limits = rec(model["limit"]);
      const cost = rec(model["cost"]);
      const capabilities = rec(model["capabilities"]);
      const capabilityInput = rec(capabilities["input"]);
      const modalities = rec(model["modalities"]);
      const inputModalities = Array.isArray(modalities["input"])
        ? modalities["input"].filter((item): item is string => typeof item === "string")
        : [];
      const variants = parseVariants(model["variants"]);
      models.push({
        id: `${providerId}/${modelId}`,
        name: typeof model["name"] === "string" ? model["name"] : modelId,
        provider: providerId,
        providerName,
        ...(variants.length ? { variants } : {}),
        ...(number(limits["context"]) !== undefined ? { contextWindow: number(limits["context"]) } : {}),
        ...(number(limits["output"]) !== undefined ? { maxOutputTokens: number(limits["output"]) } : {}),
        ...(number(cost["input"]) !== undefined ? { inputCostPerMillion: number(cost["input"]) } : {}),
        ...(number(cost["output"]) !== undefined ? { outputCostPerMillion: number(cost["output"]) } : {}),
        supportsImages: capabilityInput["image"] === true || inputModalities.includes("image"),
        supportsTools: capabilities["toolcall"] === true || model["tool_call"] === true,
      });
    }
  }
  return models;
}

export function openCodeV2ModelsFromPayload(
  modelsPayload: unknown,
  providersPayload?: unknown,
): ProviderModel[] {
  const providerNames = new Map<string, string>();
  for (const rawProvider of v2DataArray(providersPayload)) {
    const provider = rec(rawProvider);
    const id = typeof provider["id"] === "string" ? provider["id"] : "";
    if (!id) continue;
    providerNames.set(id, typeof provider["name"] === "string" ? provider["name"] : id);
  }

  const models: ProviderModel[] = [];
  for (const rawModel of v2DataArray(modelsPayload)) {
    const model = rec(rawModel);
    const modelType = typeof model["type"] === "string" ? model["type"] : "chat";
    if (modelType !== "chat") continue;
    const providerId = typeof model["providerID"] === "string" ? model["providerID"] : "";
    const modelId = typeof model["id"] === "string"
      ? model["id"]
      : typeof model["modelID"] === "string"
        ? model["modelID"]
        : "";
    if (!providerId || !modelId) continue;

    const limits = rec(model["limit"]);
    const costEntry = Array.isArray(model["cost"]) ? rec(model["cost"][0]) : rec(model["cost"]);
    const capabilities = rec(model["capabilities"]);
    const inputList = Array.isArray(capabilities["input"])
      ? capabilities["input"].filter((item): item is string => typeof item === "string")
      : [];
    const variants = parseVariants(model["variants"]);

    models.push({
      id: `${providerId}/${modelId}`,
      name: typeof model["name"] === "string" ? model["name"] : modelId,
      provider: providerId,
      providerName: providerNames.get(providerId) ?? providerId,
      ...(variants.length ? { variants } : {}),
      ...(number(limits["context"]) !== undefined ? { contextWindow: number(limits["context"]) } : {}),
      ...(number(limits["output"]) !== undefined ? { maxOutputTokens: number(limits["output"]) } : {}),
      ...(number(costEntry["input"]) !== undefined ? { inputCostPerMillion: number(costEntry["input"]) } : {}),
      ...(number(costEntry["output"]) !== undefined ? { outputCostPerMillion: number(costEntry["output"]) } : {}),
      supportsImages: inputList.includes("image"),
      supportsTools: capabilities["tools"] === true || capabilities["toolcall"] === true,
    });
  }
  return models;
}

export async function listOpenCodeModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  return withModelCache("opencode", options, options.cacheTtlMs, async () => {
    const runtime = await acquireOpenCodeRuntime(options);
    try {
      if (serverApiVersion(runtime.server) === 2) {
        const [modelsPayload, providersPayload] = await Promise.all([
          runtime.server.client.json<unknown>("/api/model"),
          runtime.server.client.json<unknown>("/api/provider").catch(() => []),
        ]);
        return openCodeV2ModelsFromPayload(modelsPayload, providersPayload);
      }
      const payload = await runtime.server.client.json<Record<string, unknown>>("/provider");
      return openCodeModelsFromPayload(payload);
    } finally {
      runtime.server.release();
    }
  });
}
