import { describe, it, expect } from "vitest";
import { getAdapter, listAdapters, registerAdapter } from "../src/registry.js";
import type { AdapterModule } from "../src/types.js";

describe("registry", () => {
  it("getAdapter returns claude adapter", () => {
    const adapter = getAdapter("claude");
    expect(adapter.type).toBe("claude");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
  });

  it("getAdapter returns codex adapter", () => {
    const adapter = getAdapter("codex");
    expect(adapter.type).toBe("codex");
  });

  it("getAdapter returns openclaw adapter", () => {
    const adapter = getAdapter("openclaw");
    expect(adapter.type).toBe("openclaw");
  });

  it("getAdapter returns process adapter", () => {
    const adapter = getAdapter("process");
    expect(adapter.type).toBe("process");
  });

  it("listAdapters returns all four types", () => {
    const types = listAdapters();
    expect(types).toContain("claude");
    expect(types).toContain("codex");
    expect(types).toContain("openclaw");
    expect(types).toContain("process");
    expect(types.length).toBeGreaterThanOrEqual(4);
  });

  it("getAdapter throws for unknown type", () => {
    expect(() => getAdapter("nonexistent")).toThrow(/Unknown adapter type "nonexistent"/);
    expect(() => getAdapter("nonexistent")).toThrow(/Available:/);
  });

  it("registerAdapter adds a custom adapter", () => {
    const custom: AdapterModule = {
      type: "custom",
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
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
        adapterType: ctx.adapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    };

    registerAdapter(custom);
    const retrieved = getAdapter("custom");
    expect(retrieved.type).toBe("custom");
    expect(listAdapters()).toContain("custom");
  });
});
