import { describe, it, expect } from "vitest";
import { aggregateUsage } from "../../src/types.js";

describe("aggregateUsage", () => {
  it("returns null for undefined input", () => {
    expect(aggregateUsage(undefined)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(aggregateUsage({})).toBeNull();
  });

  it("returns single model usage as-is", () => {
    const usage = {
      "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50 },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("aggregates inputTokens and outputTokens across multiple models", () => {
    const usage = {
      "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50 },
      "claude-haiku-4-5": { inputTokens: 200, outputTokens: 80 },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({ inputTokens: 300, outputTokens: 130 });
  });

  it("aggregates cachedInputTokens when present", () => {
    const usage = {
      "model-a": { inputTokens: 100, outputTokens: 50, cachedInputTokens: 30 },
      "model-b": { inputTokens: 200, outputTokens: 80, cachedInputTokens: 20 },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cachedInputTokens: 50,
    });
  });

  it("aggregates cacheCreationInputTokens when present", () => {
    const usage = {
      "model-a": { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10 },
      "model-b": { inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 15 },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheCreationInputTokens: 25,
    });
  });

  it("only includes optional fields when at least one model has them", () => {
    const usage = {
      "model-a": { inputTokens: 100, outputTokens: 50 },
      "model-b": { inputTokens: 200, outputTokens: 80, cachedInputTokens: 20 },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cachedInputTokens: 20,
    });
    // cacheCreationInputTokens should not be present at all
    expect(result!.cacheCreationInputTokens).toBeUndefined();
  });

  it("handles all optional fields together", () => {
    const usage = {
      "model-a": {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 30,
        cacheCreationInputTokens: 10,
      },
      "model-b": {
        inputTokens: 200,
        outputTokens: 80,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 5,
      },
    };
    const result = aggregateUsage(usage);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 15,
    });
  });
});
