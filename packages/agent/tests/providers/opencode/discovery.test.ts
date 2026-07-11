import { describe, expect, it } from "vitest";
import { openCodeModelsFromPayload } from "../../../src/providers/opencode/discovery.js";

describe("OpenCode model discovery", () => {
  it("reads image and tool support from the 1.3.2 capabilities schema", () => {
    const models = openCodeModelsFromPayload({
      all: [{
        id: "anthropic",
        name: "Anthropic",
        models: {
          sonnet: {
            id: "sonnet",
            name: "Sonnet",
            capabilities: { input: { image: true }, toolcall: true },
          },
        },
      }],
    });

    expect(models).toEqual([expect.objectContaining({
      id: "anthropic/sonnet",
      supportsImages: true,
      supportsTools: true,
    })]);
  });

  it("retains compatibility with the older modalities fields", () => {
    const [model] = openCodeModelsFromPayload({
      all: [{
        id: "legacy",
        models: {
          model: { modalities: { input: ["image"] }, tool_call: true },
        },
      }],
    });
    expect(model).toMatchObject({ supportsImages: true, supportsTools: true });
  });
});
