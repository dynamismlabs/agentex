import type { ListModelsOptions, ProviderModel } from "../../types.js";
import { acquireOpenCodeRuntime } from "./runtime.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function listOpenCodeModels(options: ListModelsOptions = {}): Promise<ProviderModel[]> {
  const runtime = await acquireOpenCodeRuntime(options);
  try {
    const payload = await runtime.server.client.json<Record<string, unknown>>("/provider");
    const providers = Array.isArray(payload["all"]) ? payload["all"] : [];
    const models: ProviderModel[] = [];
    for (const rawProvider of providers) {
      const provider = record(rawProvider);
      const providerId = typeof provider["id"] === "string" ? provider["id"] : "";
      const providerName = typeof provider["name"] === "string" ? provider["name"] : providerId;
      if (!providerId) continue;
      for (const [key, rawModel] of Object.entries(record(provider["models"]))) {
        const model = record(rawModel);
        const modelId = typeof model["id"] === "string" ? model["id"] : key;
        if (!modelId) continue;
        const limits = record(model["limit"]);
        const cost = record(model["cost"]);
        const modalities = record(model["modalities"]);
        const inputModalities = Array.isArray(modalities["input"])
          ? modalities["input"].filter((item): item is string => typeof item === "string")
          : [];
        const variants = Object.entries(record(model["variants"])).map(([id, rawVariant]) => {
          const variant = record(rawVariant);
          return {
            id,
            name: typeof variant["name"] === "string" ? variant["name"] : id,
            ...(typeof variant["description"] === "string" ? { description: variant["description"] } : {}),
            ...(variant["disabled"] === true ? { disabled: true } : {}),
          };
        });
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
          supportsImages: inputModalities.includes("image"),
          supportsTools: model["tool_call"] === true,
        });
      }
    }
    return models;
  } finally {
    runtime.server.release();
  }
}
