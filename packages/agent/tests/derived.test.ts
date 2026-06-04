import { describe, it, expect } from "vitest";
import {
  defineDerivedProvider,
  loadProvidersFromConfig,
  MalformedProviderConfigError,
  getProvider,
  registerProvider,
  listProviders,
} from "../src/index.js";
import type {
  ProviderModule,
  ExecutionContext,
  ExecutionResult,
  AuthReport,
  AuthResolveContext,
} from "../src/index.js";

const fakeResult: ExecutionResult = {
  runId: "r",
  exitCode: 0,
  signal: null,
  status: "completed",
  startedAt: "",
  completedAt: "",
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
};

const fakeAuth: AuthReport = {
  providerType: "fake",
  binary: { installed: true },
  options: [],
  source: "filesystem",
};

/** Register a capturing fake base provider and return its recorded calls. */
function makeFakeBase(type: string) {
  const calls: { execute: ExecutionContext[]; auth: (AuthResolveContext | undefined)[] } = {
    execute: [],
    auth: [],
  };
  const provider: ProviderModule = {
    type,
    capabilities: {
      sessions: false,
      modelDiscovery: false,
      quotaProbing: false,
      mcp: false,
      skills: false,
      instructions: false,
      workspace: false,
      planMode: false,
      concurrentSend: false,
      cancelQueuedMessage: false,
      modes: false,
    },
    execute: async (ctx) => {
      calls.execute.push(ctx);
      return fakeResult;
    },
    resolveAuth: async (actx) => {
      calls.auth.push(actx);
      return fakeAuth;
    },
    listModels: async () => [{ id: "base-model", name: "Base" }],
  };
  registerProvider(provider);
  return { provider, calls };
}

describe("defineDerivedProvider", () => {
  it("creates a new id that overlays env + command onto the base's execute", async () => {
    const { calls } = makeFakeBase("fake-claude");
    const derived = defineDerivedProvider({
      id: "zai",
      extends: "fake-claude",
      env: { ANTHROPIC_BASE_URL: "https://api.z.ai" },
      command: "/usr/bin/claude-zai",
    });
    expect(derived.type).toBe("zai");
    await derived.execute({ prompt: "hi" });
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0]!.env).toEqual({ ANTHROPIC_BASE_URL: "https://api.z.ai" });
    expect(calls.execute[0]!.config?.command).toBe("/usr/bin/claude-zai");
  });

  it("lets per-call ctx.env and config.command win over the derived overlay", async () => {
    const { calls } = makeFakeBase("fake-b2");
    const derived = defineDerivedProvider({
      id: "d2",
      extends: "fake-b2",
      env: { A: "1", B: "2" },
      command: "/derived",
    });
    await derived.execute({ prompt: "x", env: { B: "override" }, config: { command: "/explicit" } });
    expect(calls.execute[0]!.env).toEqual({ A: "1", B: "override" });
    expect(calls.execute[0]!.config?.command).toBe("/explicit");
  });

  it("overlays env + command onto resolveAuth", async () => {
    const { calls } = makeFakeBase("fake-b3");
    const derived = defineDerivedProvider({ id: "d3", extends: "fake-b3", env: { K: "v" }, command: "/bin" });
    await derived.resolveAuth();
    expect(calls.auth[0]?.env).toEqual({ K: "v" });
    expect(calls.auth[0]?.command).toBe("/bin");
  });

  it("replaces listModels and flips modelDiscovery when models are supplied", async () => {
    makeFakeBase("fake-b4");
    const derived = defineDerivedProvider({
      id: "d4",
      extends: "fake-b4",
      models: [{ id: "glm-5.1", name: "GLM" }],
    });
    expect(derived.capabilities.modelDiscovery).toBe(true);
    expect(await derived.listModels!()).toEqual([{ id: "glm-5.1", name: "GLM" }]);
  });

  it("applies modeId as a default, caller override wins", async () => {
    const { calls } = makeFakeBase("fake-b5");
    const derived = defineDerivedProvider({ id: "d5", extends: "fake-b5", modeId: "plan" });
    await derived.execute({ prompt: "x" });
    expect(calls.execute[0]!.config?.modeId).toBe("plan");
    await derived.execute({ prompt: "y", config: { modeId: "code" } });
    expect(calls.execute[1]!.config?.modeId).toBe("code");
  });

  it("throws on an unknown base provider", () => {
    expect(() => defineDerivedProvider({ id: "x", extends: "nope-nonexistent" })).toThrow();
  });

  it("throws MalformedProviderConfigError for extends 'acp' (wrong entry point)", () => {
    expect(() => defineDerivedProvider({ id: "x", extends: "acp" })).toThrow(MalformedProviderConfigError);
  });
});

describe("loadProvidersFromConfig", () => {
  it("registers derived providers from a { providers } map", () => {
    makeFakeBase("fake-load1");
    const built = loadProvidersFromConfig({
      providers: {
        myzai: { extends: "fake-load1", label: "ZAI", env: { ANTHROPIC_BASE_URL: "u" }, models: [{ id: "glm" }] },
      },
    });
    expect(built).toHaveLength(1);
    expect(getProvider("myzai").type).toBe("myzai");
    expect(listProviders()).toContain("myzai");
  });

  it("accepts the Paseo-style agents.providers nesting", () => {
    makeFakeBase("fake-load2");
    loadProvidersFromConfig({ agents: { providers: { p2: { extends: "fake-load2" } } } });
    expect(getProvider("p2").type).toBe("p2");
  });

  it("skips entries with enabled: false", () => {
    makeFakeBase("fake-load3");
    const built = loadProvidersFromConfig({ providers: { off: { extends: "fake-load3", enabled: false } } });
    expect(built).toHaveLength(0);
  });

  it("returns without registering when register: false", () => {
    makeFakeBase("fake-load4");
    const built = loadProvidersFromConfig({ providers: { noreg: { extends: "fake-load4" } } }, { register: false });
    expect(built).toHaveLength(1);
    expect(() => getProvider("noreg")).toThrow();
  });

  it("throws MalformedProviderConfigError on missing extends / bad env / bad models", () => {
    expect(() => loadProvidersFromConfig({ providers: { x: {} } })).toThrow(MalformedProviderConfigError);
    makeFakeBase("fake-load5");
    expect(() =>
      loadProvidersFromConfig({ providers: { x: { extends: "fake-load5", env: { K: 5 } } } }),
    ).toThrow(MalformedProviderConfigError);
    expect(() =>
      loadProvidersFromConfig({ providers: { x: { extends: "fake-load5", models: [{ name: "no id" }] } } }),
    ).toThrow(MalformedProviderConfigError);
  });

  it("rejects a config with no providers map", () => {
    expect(() => loadProvidersFromConfig(null)).toThrow(MalformedProviderConfigError);
    expect(() => loadProvidersFromConfig({})).toThrow(MalformedProviderConfigError);
  });

  it("rejects a multi-element command array for a non-ACP provider (would drop args)", () => {
    makeFakeBase("fake-cmdarr");
    expect(() =>
      loadProvidersFromConfig({ providers: { x: { extends: "fake-cmdarr", command: ["bin", "--flag"] } } }),
    ).toThrow(MalformedProviderConfigError);
  });

  it("accepts a single-element command array for a non-ACP provider", () => {
    makeFakeBase("fake-cmd1");
    const built = loadProvidersFromConfig(
      { providers: { x: { extends: "fake-cmd1", command: ["bin"] } } },
      { register: false },
    );
    expect(built).toHaveLength(1);
  });
});
