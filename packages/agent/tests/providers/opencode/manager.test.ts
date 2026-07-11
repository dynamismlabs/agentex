import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock("../../../src/providers/opencode/runtime.js", () => ({
  acquireOpenCodeRuntime: mocks.acquire,
}));

import {
  openCodeUpstreamProviders,
  OpenCodeDisconnectUnsupportedError,
} from "../../../src/providers/opencode/manager.js";

function runtime(options: {
  doc?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  methods?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ kind: string; path?: string; init?: RequestInit }> = [];
  const handle = {
    client: {
      async json(path: string) {
        calls.push({ kind: "json", path });
        if (path === "/doc") return options.doc ?? { paths: { "/auth/{providerID}": { delete: {} } } };
        if (path === "/provider") return options.providers ?? {
          all: [{ id: "anthropic", name: "Anthropic", models: {} }],
          connected: ["anthropic"],
        };
        if (path === "/provider/auth") return options.methods ?? {
          anthropic: [{ type: "api", label: "API key" }, { type: "oauth", label: "Claude Pro" }],
        };
        if (path.includes("/oauth/authorize")) return {
          url: "https://example.test/oauth", method: "code", instructions: "Enter the returned code",
        };
        throw new Error(`unexpected json path ${path}`);
      },
      async ok(path: string, init?: RequestInit) {
        calls.push({ kind: "ok", path, init });
      },
    },
    release: vi.fn(),
    retire: vi.fn(async () => undefined),
    retireAuthStore: vi.fn(async () => undefined),
    isCurrent: () => true,
    generation: 0,
  };
  return { runtime: { server: handle, cwd: "/tmp", env: {}, resolved: { bin: "opencode", prefixArgs: [] } }, handle, calls };
}

describe("OpenCode upstream provider manager", () => {
  beforeEach(() => mocks.acquire.mockReset());
  afterEach(() => vi.useRealTimers());

  it("returns secret-free provider and auth method metadata", async () => {
    const fake = runtime();
    mocks.acquire.mockResolvedValue(fake.runtime);
    const providers = await openCodeUpstreamProviders.list();
    expect(providers).toEqual([{
      id: "anthropic", name: "Anthropic", connected: true,
      authMethodIds: [expect.stringMatching(/^ocm_/), expect.stringMatching(/^ocm_/)],
    }]);
    const methods = await openCodeUpstreamProviders.authMethods("anthropic");
    expect(methods.map((method) => method.type)).toEqual(["api_key", "oauth"]);
    expect(JSON.stringify({ providers, methods })).not.toContain("methodIndex");
  });

  it("writes an API key once, returns no secret, and retires the runtime", async () => {
    const fake = runtime();
    mocks.acquire.mockResolvedValue(fake.runtime);
    await expect(openCodeUpstreamProviders.setApiKey("anthropic", "secret-key")).resolves.toBeUndefined();
    const write = fake.calls.find((call) => call.kind === "ok");
    expect(write?.path).toBe("/auth/anthropic");
    expect(JSON.parse(String(write?.init?.body))).toEqual({ type: "api", key: "secret-key" });
    expect(fake.handle.retireAuthStore).toHaveBeenCalledOnce();
    expect(fake.handle.release).toHaveBeenCalledOnce();
  });

  it("keeps OAuth method indexes inside the single-use flow", async () => {
    const fake = runtime();
    mocks.acquire.mockResolvedValue(fake.runtime);
    const methods = await openCodeUpstreamProviders.authMethods("anthropic");
    fake.handle.release.mockClear();
    const flow = await openCodeUpstreamProviders.beginOAuth("anthropic", methods[1]!.id);
    expect(flow).toMatchObject({
      id: expect.stringMatching(/^ocf_/), providerId: "anthropic", completion: "code",
      url: "https://example.test/oauth",
    });
    expect(JSON.stringify(flow)).not.toContain("methodIndex");
    await openCodeUpstreamProviders.completeOAuth(flow.id, "returned-code");
    const callback = fake.calls.find((call) => call.path?.includes("/oauth/callback"));
    expect(JSON.parse(String(callback?.init?.body))).toEqual({ method: 1, code: "returned-code" });
    expect(fake.handle.retireAuthStore).toHaveBeenCalledOnce();
  });

  it("releases an abandoned OAuth flow when its TTL expires", async () => {
    vi.useFakeTimers();
    const fake = runtime();
    mocks.acquire.mockResolvedValue(fake.runtime);
    const methods = await openCodeUpstreamProviders.authMethods("anthropic");
    fake.handle.release.mockClear();
    await openCodeUpstreamProviders.beginOAuth("anthropic", methods[1]!.id);
    expect(fake.handle.release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fake.handle.release).toHaveBeenCalledOnce();
  });

  it("uses the generated 1.3.2 delete endpoint and rejects unknown profiles", async () => {
    const supported = runtime();
    mocks.acquire.mockResolvedValue(supported.runtime);
    await expect(openCodeUpstreamProviders.canDisconnect("anthropic")).resolves.toBe(true);
    await openCodeUpstreamProviders.disconnect("anthropic");
    expect(supported.calls.some((call) => call.kind === "ok" && call.path === "/auth/anthropic")).toBe(true);
    expect(supported.handle.retireAuthStore).toHaveBeenCalledWith({ force: true });

    const unsupported = runtime({ doc: { paths: {} } });
    mocks.acquire.mockResolvedValue(unsupported.runtime);
    await expect(openCodeUpstreamProviders.disconnect("anthropic"))
      .rejects.toBeInstanceOf(OpenCodeDisconnectUnsupportedError);
  });
});
