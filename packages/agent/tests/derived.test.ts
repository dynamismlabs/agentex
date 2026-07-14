import { describe, it, expect } from "vitest";
import {
  defineDerivedProvider,
  loadProvidersFromConfig,
  MalformedProviderConfigError,
  getProvider,
  registerProvider,
  registerAcpFactory,
  listProviders,
  acpProvider,
  createSessionRecord,
} from "../src/index.js";
import type {
  AgentSession,
  ProviderModule,
  ExecutionContext,
  ExecutionResult,
  AuthReport,
  AuthResolveContext,
  SessionContext,
  SavedHistorySession,
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

  it("preserves derived identity and overlays across describe, attach, and resume", async () => {
    const creates: SessionContext[] = [];
    const attachCalls: Array<{
      providerType: string;
      env?: Record<string, string>;
      command?: string;
    }> = [];
    const makeSession = (): AgentSession => ({
      sessionId: "sess-derived",
      state: "idle",
      send: async () => ({
        uuid: "u",
        result: Promise.resolve({
          summary: null, costUsd: null, status: "completed", errorCode: null, errorMessage: null,
        }),
      }),
      cancel: async () => ({ cancelled: false }),
      stopTask: async () => ({ stopped: false }),
      setGoal: async () => ({ armed: true, mechanism: "emulated" }),
      clearGoal: async () => ({ cleared: false }),
      getGoal: () => null,
      interrupt: async () => {},
      drain: async () => {},
      close: async () => {},
      describe: () => createSessionRecord({
        providerType: "durable-base",
        params: { sessionId: "sess-derived", cwd: "/saved" },
        cwd: "/saved",
      }),
    });
    const base: ProviderModule = {
      type: "durable-base",
      capabilities: {
        sessions: true, modelDiscovery: false, quotaProbing: false, mcp: false,
        skills: false, instructions: false, workspace: false, planMode: false,
        concurrentSend: false, cancelQueuedMessage: false, stopTask: false, modes: false,
        durableSessions: true,
      },
      execute: async () => fakeResult,
      resolveAuth: async () => fakeAuth,
      createSession: async (ctx) => { creates.push(ctx); return makeSession(); },
      attachSession: async (record, opts) => {
        attachCalls.push({
          providerType: record.providerType,
          env: opts?.env,
          command: opts?.config?.command,
        });
        return {
          record,
          transcript: null,
          lastTurn: "completed",
          catchUp: async function* () {},
          resume: async () => makeSession(),
        };
      },
    };
    registerProvider(base);
    const derived = defineDerivedProvider({
      id: "durable-derived",
      extends: "durable-base",
      env: { DERIVED_KEY: "yes", SHARED: "base" },
      command: "/derived-command",
    });

    const live = await derived.createSession!({ env: { SHARED: "caller" } });
    const record = live.describe!()!;
    expect(record.providerType).toBe("durable-derived");
    expect(creates[0]).toMatchObject({
      env: { DERIVED_KEY: "yes", SHARED: "caller" },
      config: { command: "/derived-command" },
    });

    const attachment = await derived.attachSession!(record, { env: { SHARED: "attach" } });
    expect(attachCalls).toEqual([{
      providerType: "durable-base",
      env: { DERIVED_KEY: "yes", SHARED: "attach" },
      command: "/derived-command",
    }]);
    expect(attachment.record.providerType).toBe("durable-derived");
    await attachment.resume();
    expect(creates.at(-1)).toMatchObject({
      cwd: "/saved",
      env: { DERIVED_KEY: "yes", SHARED: "base" },
      config: { command: "/derived-command" },
      sessionParams: { sessionId: "sess-derived", cwd: "/saved" },
    });
  });

  it("applies derived runtime overlays to upstream provider management", async () => {
    const contexts: Array<SessionContext | undefined> = [];
    const { provider } = makeFakeBase("managed-base");
    provider.upstreamProviders = {
      list: async (ctx) => { contexts.push(ctx); return []; },
      authMethods: async (_providerId, ctx) => { contexts.push(ctx); return []; },
      setApiKey: async (_providerId, _key, ctx) => { contexts.push(ctx); },
      beginOAuth: async (providerId, _methodId, _inputs, ctx) => {
        contexts.push(ctx);
        return {
          id: "flow", providerId, url: null, completion: "code",
          instructions: null, expiresAt: new Date().toISOString(),
        };
      },
      completeOAuth: async (_flowId, _code, ctx) => { contexts.push(ctx); },
      canDisconnect: async (_providerId, ctx) => { contexts.push(ctx); return true; },
      disconnect: async (_providerId, ctx) => { contexts.push(ctx); },
    };
    const derived = defineDerivedProvider({
      id: "managed-derived",
      extends: "managed-base",
      env: { XDG_DATA_HOME: "/derived-data", SHARED: "base" },
      command: "/derived-opencode",
      modeId: "plan",
    });

    await derived.upstreamProviders!.list({ env: { SHARED: "caller" } });
    expect(contexts[0]).toMatchObject({
      env: { XDG_DATA_HOME: "/derived-data", SHARED: "caller" },
      config: { command: "/derived-opencode", modeId: "plan" },
    });
  });

  it("preserves derived identity and runtime overlays for saved history", async () => {
    const contexts: Array<{ env?: Record<string, string>; command?: string }> = [];
    const readSessions: SavedHistorySession[] = [];
    const { provider } = makeFakeBase("saved-base");
    provider.capabilities.savedHistory = true;
    const baseSession: SavedHistorySession = {
      version: 1,
      providerType: "saved-base",
      externalSessionId: "ses_saved",
      cwd: "/saved-project",
      title: "Saved",
      startedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:01:00.000Z",
      branch: null,
      gitOriginUrl: null,
      archiveState: "active",
      hasUserMessage: true,
    };
    provider.savedHistory = {
      probe: async (options) => {
        contexts.push({ env: options?.env, command: options?.config?.command });
        return {
          providerType: "saved-base",
          sourceAvailable: true,
          historyAvailable: true,
          approximateCount: 1,
        };
      },
      discover: (options) => ({
        async *[Symbol.asyncIterator]() {
          contexts.push({ env: options?.env, command: options?.config?.command });
          yield baseSession;
        },
      }),
      read: (session, options) => ({
        async *[Symbol.asyncIterator]() {
          readSessions.push(session);
          contexts.push({ env: options?.env, command: options?.config?.command });
          yield {
            event: {
              type: "user" as const,
              text: "hello",
              timestamp: "2026-07-14T00:00:00.000Z",
              providerType: "saved-base",
              sessionId: "ses_saved",
              messageId: "msg_saved",
              eventId: "msg_saved",
              turnId: null,
              parentToolCallId: null,
              raw: {},
            },
            checkpoint: { kind: "saved", value: 1 },
            eventId: "msg_saved",
            partIndex: 0,
          };
        },
      }),
    };
    const derived = defineDerivedProvider({
      id: "saved-derived",
      extends: "saved-base",
      env: { XDG_DATA_HOME: "/derived", SHARED: "base" },
      command: "/derived-opencode",
    });

    expect(await derived.savedHistory!.probe({ env: { SHARED: "probe" } }))
      .toMatchObject({ providerType: "saved-derived", historyAvailable: true });
    const discovered: SavedHistorySession[] = [];
    for await (const session of derived.savedHistory!.discover()) discovered.push(session);
    expect(discovered[0]?.providerType).toBe("saved-derived");
    const events = [];
    for await (const item of derived.savedHistory!.read(discovered[0]!, {
      env: { SHARED: "read" },
    })) events.push(item);

    expect(readSessions[0]?.providerType).toBe("saved-base");
    expect(events[0]?.event.providerType).toBe("saved-derived");
    expect(contexts).toEqual([
      { env: { XDG_DATA_HOME: "/derived", SHARED: "probe" }, command: "/derived-opencode" },
      { env: { XDG_DATA_HOME: "/derived", SHARED: "base" }, command: "/derived-opencode" },
      { env: { XDG_DATA_HOME: "/derived", SHARED: "read" }, command: "/derived-opencode" },
    ]);
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

  it("builds an extends:'acp' provider via the default factory (no registerAcpFactory needed)", () => {
    // The cycle fix (spec §5.3) makes the built-in acpProvider the default ACP
    // factory, so ACP configs load without any prior import/registration.
    const built = loadProvidersFromConfig(
      { providers: { myacp: { extends: "acp", command: ["gemini", "--acp"] } } },
      { register: false },
    );
    expect(built).toHaveLength(1);
    expect(built[0]!.type).toBe("myacp");
    // ACP providers are session-capable and negotiate real capabilities at
    // handshake — a cheap structural proof the acpProvider factory built it.
    expect(built[0]!.capabilities.sessions).toBe(true);
    expect(typeof built[0]!.execute).toBe("function");
  });

  it("honors a custom registerAcpFactory override for extends:'acp'", () => {
    const calls: Array<{ id: string; command: string[] }> = [];
    const custom = (cfg: { id: string; command: string[] }): ProviderModule => {
      calls.push({ id: cfg.id, command: cfg.command });
      return {
        type: cfg.id,
        capabilities: {
          sessions: true,
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
        execute: async () => fakeResult,
        resolveAuth: async () => ({ ...fakeAuth, providerType: cfg.id }),
      };
    };
    try {
      registerAcpFactory(custom as never);
      const built = loadProvidersFromConfig(
        { providers: { ov: { extends: "acp", command: ["x", "--acp"] } } },
        { register: false },
      );
      expect(built).toHaveLength(1);
      expect(calls).toEqual([{ id: "ov", command: ["x", "--acp"] }]);
    } finally {
      // Restore the default factory so other tests see the built-in path.
      registerAcpFactory(acpProvider as never);
    }
  });
});
