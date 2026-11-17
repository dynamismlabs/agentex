import { describe, expect, it } from "vitest";
import { openCodeModelsFromPayload, openCodeV2ModelsFromPayload } from "../../../src/providers/opencode/discovery.js";
import { openCodeVariant, splitOpenCodeVariants } from "../../../src/providers/opencode/effort.js";

describe("OpenCode effort", () => {
  it("reports effort-named variants as efforts, weakest first, and keeps the others as variants", () => {
    expect(splitOpenCodeVariants([
      { id: "max", name: "max" },
      { id: "thinking", name: "Thinking", description: "A user's own variant" },
      { id: "low", name: "low" },
      { id: "none", name: "none" },
      { id: "xhigh", name: "xhigh", disabled: true },
      { id: "high", name: "high", isDefault: true },
    ])).toEqual({
      variants: [{ id: "thinking", name: "Thinking", description: "A user's own variant" }],
      supportedEfforts: ["none", "low", "high", "max"],
      defaultEffort: "high",
    });
  });

  it("leaves a model with no variants, or only its own, as it was", () => {
    expect(splitOpenCodeVariants([])).toEqual({});
    expect(splitOpenCodeVariants([{ id: "fast", name: "Fast" }])).toEqual({ variants: [{ id: "fast", name: "Fast" }] });
  });

  it("reads OpenCode 2.3.0's variants, which each set only their effort", () => {
    const [claude, small] = openCodeV2ModelsFromPayload({
      data: [
        {
          id: "claude-opus-5-5", providerID: "anthropic", type: "chat", name: "Claude Opus 5.5",
          variants: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, settings: { thinking: { type: "adaptive" }, effort: id } })),
        },
        {
          id: "inkling-2-small-free", providerID: "opencode", type: "chat", name: "Inkling 2 Small",
          variants: ["none", "minimal", "low", "medium", "high", "max"].map((id) => ({ id, settings: { reasoningEffort: id } })),
        },
      ],
    });
    expect(claude).toMatchObject({ id: "anthropic/claude-opus-5-5", supportedEfforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(claude).not.toHaveProperty("variants");
    expect(small).toMatchObject({ supportedEfforts: ["none", "minimal", "low", "medium", "high", "max"] });
  });

  it("does the same for OpenCode 1's keyed variants", () => {
    const [model] = openCodeModelsFromPayload({
      all: [{ id: "openai", models: { "gpt-5": { name: "GPT-5", variants: { minimal: {}, high: {}, custom: { name: "Custom" } } } } }],
    });
    expect(model).toMatchObject({ supportedEfforts: ["minimal", "high"], variants: [{ id: "custom", name: "Custom" }] });
  });

  it("sends the effort as the variant, unless a variant is set", () => {
    expect(openCodeVariant({ effort: "high" })).toBe("high");
    expect(openCodeVariant({ effort: "high", modelVariant: "thinking" })).toBe("thinking");
    expect(openCodeVariant({ modelVariant: "thinking" })).toBe("thinking");
    expect(openCodeVariant({ effort: "" })).toBeUndefined();
    expect(openCodeVariant(undefined)).toBeUndefined();
  });
});
