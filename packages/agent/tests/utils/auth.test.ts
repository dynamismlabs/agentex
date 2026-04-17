import { describe, it, expect } from "vitest";
import { detectAuth } from "../../src/utils/auth.js";

describe("detectAuth", () => {
  describe("claude provider", () => {
    it("returns api_key auth when ANTHROPIC_API_KEY is set", () => {
      const result = detectAuth("claude", { ANTHROPIC_API_KEY: "sk-ant-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns bedrock auth when ANTHROPIC_BEDROCK_BASE_URL is set", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
      });
      expect(result.method).toBe("bedrock");
      expect(result.billingType).toBe("metered_api");
      expect(result.resolveModelId).toBeTypeOf("function");
    });

    it("returns bedrock auth when AWS_ACCESS_KEY_ID and AWS_REGION are set", () => {
      const result = detectAuth("claude", {
        AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
        AWS_REGION: "us-west-2",
      });
      expect(result.method).toBe("bedrock");
      expect(result.billingType).toBe("metered_api");
      expect(result.region).toBe("us-west-2");
      expect(result.resolveModelId).toBeTypeOf("function");
    });

    it("resolveModelId maps known models to bedrock IDs", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
        AWS_REGION: "us",
      });
      const mapped = result.resolveModelId!("claude-sonnet-4-6");
      expect(mapped).toBe("us.anthropic.claude-sonnet-4-6-v1");
    });

    it("resolveModelId passes through unknown models", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com",
      });
      const mapped = result.resolveModelId!("custom-model");
      expect(mapped).toBe("custom-model");
    });

    it("bedrock takes priority over api_key", () => {
      const result = detectAuth("claude", {
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
        ANTHROPIC_API_KEY: "sk-ant-123",
      });
      expect(result.method).toBe("bedrock");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("claude", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });

    it("ignores empty-string API key", () => {
      const result = detectAuth("claude", { ANTHROPIC_API_KEY: "   " });
      expect(result.method).toBe("subscription");
    });
  });

  describe("codex provider", () => {
    it("returns api_key auth when OPENAI_API_KEY is set", () => {
      const result = detectAuth("codex", { OPENAI_API_KEY: "sk-openai-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("codex", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });

  describe("gemini provider", () => {
    it("returns api_key auth when GEMINI_API_KEY is set", () => {
      const result = detectAuth("gemini", { GEMINI_API_KEY: "gem-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns api_key auth when GOOGLE_API_KEY is set", () => {
      const result = detectAuth("gemini", { GOOGLE_API_KEY: "goog-123" });
      expect(result.method).toBe("api_key");
      expect(result.billingType).toBe("api");
    });

    it("returns subscription fallback when no keys are set", () => {
      const result = detectAuth("gemini", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });

  describe("unknown provider", () => {
    it("returns subscription fallback for unrecognized provider", () => {
      const result = detectAuth("unknown-provider", {});
      expect(result.method).toBe("subscription");
      expect(result.billingType).toBe("subscription");
    });
  });
});
