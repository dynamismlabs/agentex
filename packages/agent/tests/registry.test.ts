import { describe, it, expect } from "vitest";
import { getProvider, listProviders, registerProvider } from "../src/registry.js";
import type { ProviderModule } from "../src/types.js";

describe("registry", () => {
  it("getProvider returns claude provider", () => {
    const provider = getProvider("claude");
    expect(provider.type).toBe("claude");
    expect(typeof provider.execute).toBe("function");
    expect(typeof provider.resolveAuth).toBe("function");
  });

  it("getProvider returns codex provider", () => {
    const provider = getProvider("codex");
    expect(provider.type).toBe("codex");
  });

  it("getProvider returns openclaw provider", () => {
    const provider = getProvider("openclaw");
    expect(provider.type).toBe("openclaw");
  });

  it("getProvider returns process provider", () => {
    const provider = getProvider("process");
    expect(provider.type).toBe("process");
  });

  it("getProvider returns gemini provider", () => {
    const provider = getProvider("gemini");
    expect(provider.type).toBe("gemini");
  });

  it("getProvider returns cursor provider", () => {
    const provider = getProvider("cursor");
    expect(provider.type).toBe("cursor");
  });

  it("getProvider returns opencode provider", () => {
    const provider = getProvider("opencode");
    expect(provider.type).toBe("opencode");
  });

  it("getProvider returns pi provider", () => {
    const provider = getProvider("pi");
    expect(provider.type).toBe("pi");
  });

  it("listProviders returns all registered types", () => {
    const types = listProviders();
    expect(types).toContain("claude");
    expect(types).toContain("codex");
    expect(types).toContain("openclaw");
    expect(types).toContain("process");
    expect(types).toContain("gemini");
    expect(types).toContain("cursor");
    expect(types).toContain("opencode");
    expect(types).toContain("pi");
    expect(types.length).toBeGreaterThanOrEqual(8);
  });

  it("getProvider throws for unknown type", () => {
    expect(() => getProvider("nonexistent")).toThrow(/Unknown provider type "nonexistent"/);
    expect(() => getProvider("nonexistent")).toThrow(/Available:/);
  });

  it("registerProvider adds a custom provider", () => {
    const custom: ProviderModule = {
      type: "custom",
      execute: async () => ({
        runId: "test",
        exitCode: 0,
        signal: null,
        status: "completed" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        errorMessage: null,
        errorCode: null,
        costUsd: null,
        model: null,
        summary: null,
        sessionParams: null,
        sessionDisplayId: null,
        clearSession: false,
        billingType: null,
      }),
      testEnvironment: async (ctx) => ({
        providerType: ctx.providerType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    };

    registerProvider(custom);
    const retrieved = getProvider("custom");
    expect(retrieved.type).toBe("custom");
    expect(listProviders()).toContain("custom");
  });
});
