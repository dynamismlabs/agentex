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
      expect(typeof provider.capabilities.concurrentSend).toBe("boolean");
      expect(typeof provider.capabilities.cancelQueuedMessage).toBe("boolean");
      expect(typeof provider.capabilities.stopTask).toBe("boolean");
      expect(typeof provider.capabilities.modes).toBe("boolean");
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
      skillInventory: "provider-init",
      skillInvocation: "native-slash",
      instructions: true,
      workspace: true,
      planMode: true,
      concurrentSend: true,
      cancelQueuedMessage: true,
      stopTask: true,
      backgroundTaskEvents: true,
      modes: false,
      goals: {
        mechanism: "sentinel",
        enforced: true,
        statuses: ["active", "met", "cleared"],
        clears: "both",
        telemetry: false,
      },
      durableSessions: true,
      durableHistory: true,
      localHistory: true,
      resume: true,
      modelVariants: false,
      permissionRequests: true,
      questionRequests: true,
      strictMcpIsolation: true,
      upstreamProviderDisconnect: false,
      sessionModelChange: true,
      sessionVariantChange: false,
      sessionEffortChange: true,
      sessionModeChange: true,
    });
  });

  it("claude and codex declare their complete host session-control contract", () => {
    expect(getProvider("claude").capabilities).toMatchObject({
      resume: true,
      permissionRequests: true,
      questionRequests: true,
      strictMcpIsolation: true,
      sessionModelChange: true,
      sessionVariantChange: false,
      sessionEffortChange: true,
      sessionModeChange: true,
    });
    expect(getProvider("codex").capabilities).toMatchObject({
      resume: true,
      permissionRequests: true,
      questionRequests: true,
      strictMcpIsolation: false,
      sessionModelChange: true,
      sessionVariantChange: false,
      sessionEffortChange: true,
      sessionModeChange: false,
    });
  });

  it("claude and codex advertise native goal support; others don't statically", () => {
    const claude = getProvider("claude").capabilities.goals;
    expect(claude?.mechanism).toBe("sentinel");
    expect(claude?.enforced).toBe(true);

    const codex = getProvider("codex").capabilities.goals;
    expect(codex?.mechanism).toBe("model-tools");
    expect(codex?.enforced).toBe(false);
    expect(codex?.telemetry).toBe(true);

    // Sessionless / non-native providers carry no static goal capability;
    // their sessions (where they exist) still emulate via the GoalController.
    expect(getProvider("openclaw").capabilities.goals).toBeUndefined();
    expect(getProvider("process").capabilities.goals).toBeUndefined();
  });

  it("claude and codex are the only providers with concurrentSend", () => {
    for (const name of listProviders()) {
      const caps = getProvider(name).capabilities;
      const expected = name === "claude" || name === "codex";
      expect(caps.concurrentSend).toBe(expected);
    }
  });

  it("only claude supports per-message cancel", () => {
    // Codex's JSON-RPC has no per-message cancel; only turn/interrupt.
    for (const name of listProviders()) {
      const caps = getProvider(name).capabilities;
      const expected = name === "claude";
      expect(caps.cancelQueuedMessage).toBe(expected);
    }
  });

  it("only claude supports per-task stop", () => {
    // Claude's CLI exposes a `stop_task` control request; no other provider
    // does, so stopTask() is a documented no-op ({stopped:false}) elsewhere.
    for (const name of listProviders()) {
      const caps = getProvider(name).capabilities;
      const expected = name === "claude";
      expect(caps.stopTask).toBe(expected);
    }
  });

  it("claude and codex emit normalized background-task lifecycle events", () => {
    for (const name of listProviders()) {
      const expected = name === "claude" || name === "codex";
      expect(getProvider(name).capabilities.backgroundTaskEvents === true).toBe(expected);
    }
  });

  it("claude, codex, Cursor, and OpenCode advertise plan mode", () => {
    for (const name of listProviders()) {
      const caps = getProvider(name).capabilities;
      const expected = name === "claude" || name === "codex" || name === "cursor" || name === "opencode";
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

  it("declares provider-specific skill inventory and invocation behavior", () => {
    const claude = getProvider("claude").capabilities;
    expect(claude.skillInventory).toBe("provider-init");
    expect(claude.skillInvocation).toBe("native-slash");

    const codex = getProvider("codex").capabilities;
    expect(codex.skillInventory).toBe("local-discovery");
    expect(codex.skillInvocation).toBe("expanded-prompt");
  });

  it("advertises durableSessions only where attachSession is implemented", () => {
    // Honest capability detection (spec §2): true for claude/codex, absent
    // elsewhere — and the flag must match the presence of `attachSession`.
    for (const type of ["claude", "codex"]) {
      const p = getProvider(type);
      expect(p.capabilities.durableSessions).toBe(true);
      expect(typeof p.attachSession).toBe("function");
    }
    for (const type of ["openclaw", "cursor", "process", "opencode", "pi", "gemini", "copilot"]) {
      const p = getProvider(type);
      expect(p.capabilities.durableSessions).toBeUndefined();
      expect(p.attachSession).toBeUndefined();
    }
  });

  it("advertises localHistory only where local discovery is implemented", () => {
    for (const type of listProviders()) {
      const provider = getProvider(type);
      const expected = type === "claude" || type === "codex";
      expect(provider.capabilities.localHistory === true).toBe(expected);
      expect(typeof provider.localHistory === "object").toBe(expected);
    }
  });

  it("advertises savedHistory only where provider-neutral discovery is implemented", () => {
    for (const type of listProviders()) {
      const provider = getProvider(type);
      const expected = type === "opencode";
      expect(provider.capabilities.savedHistory === true).toBe(expected);
      expect(typeof provider.savedHistory === "object").toBe(expected);
    }
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

  it("capabilities.modes is true iff listModes is present", () => {
    for (const name of listProviders()) {
      const provider = getProvider(name);
      expect(provider.capabilities.modes).toBe(provider.listModes !== undefined);
    }
  });
});
