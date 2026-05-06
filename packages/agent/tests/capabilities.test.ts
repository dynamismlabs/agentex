import { describe, it, expect } from "vitest";
import { getProvider, listProviders } from "../src/index.js";

describe("ProviderCapabilities", () => {
  it("every registered provider declares capabilities", () => {
    for (const name of listProviders()) {
      const provider = getProvider(name);
      expect(provider.capabilities).toBeDefined();
      expect(typeof provider.capabilities.sessions).toBe("boolean");
      expect(typeof provider.capabilities.modelDiscovery).toBe("boolean");
      expect(typeof provider.capabilities.quotaProbing).toBe("boolean");
      expect(typeof provider.capabilities.mcp).toBe("boolean");
      expect(typeof provider.capabilities.skills).toBe("boolean");
      expect(typeof provider.capabilities.instructions).toBe("boolean");
      expect(typeof provider.capabilities.workspace).toBe("boolean");
      expect(typeof provider.capabilities.planMode).toBe("boolean");
    }
  });

  it("claude declares its capabilities", () => {
    const caps = getProvider("claude").capabilities;
    expect(caps).toEqual({
      sessions: true,
      modelDiscovery: false,
      quotaProbing: true,
      mcp: true,
      skills: true,
      instructions: true,
      workspace: true,
      planMode: true,
    });
  });

  it("only claude and codex advertise native plan mode", () => {
    for (const name of listProviders()) {
      const caps = getProvider(name).capabilities;
      const expected = name === "claude" || name === "codex";
      expect(caps.planMode).toBe(expected);
    }
  });

  it("codex has sessions but no model discovery, mcp, or quota", () => {
    const caps = getProvider("codex").capabilities;
    expect(caps.sessions).toBe(true);
    expect(caps.modelDiscovery).toBe(false);
    expect(caps.quotaProbing).toBe(false);
    expect(caps.mcp).toBe(false);
  });

  it("openclaw has no capabilities", () => {
    const caps = getProvider("openclaw").capabilities;
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });

  it("process supports only instructions and workspace", () => {
    const caps = getProvider("process").capabilities;
    expect(caps.instructions).toBe(true);
    expect(caps.workspace).toBe(true);
    expect(caps.sessions).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.skills).toBe(false);
  });

  it("capabilities.sessions matches presence of createSession", () => {
    for (const name of listProviders()) {
      const provider = getProvider(name);
      if (provider.capabilities.sessions) {
        expect(provider.createSession).toBeDefined();
      }
    }
  });

  it("capabilities.modelDiscovery matches presence of listModels", () => {
    for (const name of listProviders()) {
      const provider = getProvider(name);
      if (provider.capabilities.modelDiscovery) {
        expect(provider.listModels).toBeDefined();
      }
    }
  });

  it("capabilities.quotaProbing matches presence of checkQuota", () => {
    for (const name of listProviders()) {
      const provider = getProvider(name);
      if (provider.capabilities.quotaProbing) {
        expect(provider.checkQuota).toBeDefined();
      }
    }
  });
});
