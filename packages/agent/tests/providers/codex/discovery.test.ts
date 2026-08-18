import { describe, expect, it } from "vitest";
import { parseCodexModelCatalog } from "../../../src/providers/codex/discovery.js";

function catalog(models: unknown[]): string {
  return JSON.stringify({ models });
}

const SOL = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
  ],
  visibility: "list",
};

describe("parseCodexModelCatalog", () => {
  it("carries per-model efforts and the model's own default through", () => {
    expect(parseCodexModelCatalog(catalog([SOL]))).toEqual([{
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model",
      supportedEfforts: ["low", "xhigh", "ultra"],
      defaultEffort: "low",
    }]);
  });

  it("keeps efforts per model rather than flattening them across the catalog", () => {
    const models = parseCodexModelCatalog(catalog([
      SOL,
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
        visibility: "list",
      },
    ]));
    expect(models[1]?.supportedEfforts).toEqual(["low", "xhigh"]);
    expect(models[1]?.supportedEfforts).not.toContain("ultra");
  });

  it("hides models the CLI accepts but does not offer", () => {
    const models = parseCodexModelCatalog(catalog([
      SOL,
      { slug: "gpt-legacy", display_name: "Legacy", visibility: "hidden" },
    ]));
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("drops malformed and duplicate entries instead of emitting broken ids", () => {
    const models = parseCodexModelCatalog(catalog([
      SOL,
      SOL,
      { slug: "no-name", visibility: "list" },
      { display_name: "No Slug", visibility: "list" },
    ]));
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("omits effort fields entirely when the CLI advertises none", () => {
    const models = parseCodexModelCatalog(catalog([
      { slug: "bare", display_name: "Bare", visibility: "list" },
    ]));
    expect(models[0]).toEqual({ id: "bare", name: "Bare" });
  });

  it("ignores reasoning levels that are not the documented object shape", () => {
    const models = parseCodexModelCatalog(catalog([
      { slug: "odd", display_name: "Odd", visibility: "list", supported_reasoning_levels: ["low", 7] },
    ]));
    expect(models[0]?.supportedEfforts).toBeUndefined();
  });

  it("throws rather than reporting an empty catalog as success", () => {
    expect(() => parseCodexModelCatalog(catalog([]))).toThrow(/no visible models/);
    expect(() => parseCodexModelCatalog(JSON.stringify({}))).toThrow(/no models array/);
  });
});
