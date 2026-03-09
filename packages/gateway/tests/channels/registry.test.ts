import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type {
  ChannelPlugin,
  ChannelContext,
  ChannelStatus,
  SendResult,
  OutboundMessage,
} from "../../src/types.js";
import type { Server } from "node:http";

function makePlugin(id: string, overrides?: Partial<ChannelPlugin>): ChannelPlugin {
  return {
    id,
    label: id,
    capabilities: { chatTypes: ["direct"] },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<ChannelStatus> => ({ ok: true })),
    send: vi.fn(async (_msg: OutboundMessage): Promise<SendResult> => ({ ok: true })),
    ...overrides,
  };
}

function makeCtx(): Omit<ChannelContext, "config"> {
  return {
    onMessage: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    httpServer: {} as Server,
  };
}

describe("ChannelRegistry", () => {
  it("register and get by id", () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin("slack");
    reg.register(plugin);

    expect(reg.get("slack")).toBe(plugin);
    expect(reg.get("unknown")).toBeUndefined();
  });

  it("register with accountId creates compound key", () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin("slack");
    reg.register(plugin, "work");

    expect(reg.get("slack")).toBe(plugin);
    expect(reg.get("slack:work")).toBe(plugin);
  });

  it("getByInstance without accountId", () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin("telegram");
    reg.register(plugin);

    expect(reg.getByInstance("telegram")).toBe(plugin);
    expect(reg.getByInstance("telegram", "acct1")).toBeUndefined();
  });

  it("getByInstance with accountId", () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin("slack");
    reg.register(plugin, "personal");

    expect(reg.getByInstance("slack", "personal")).toBe(plugin);
    expect(reg.getByInstance("slack")).toBe(plugin);
  });

  it("getAll returns unique plugins", () => {
    const reg = new ChannelRegistry();
    const p1 = makePlugin("slack");
    const p2 = makePlugin("telegram");
    reg.register(p1, "acct1");
    reg.register(p2);

    const all = reg.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(p1);
    expect(all).toContain(p2);
  });

  it("startAll starts all channels and logs failures", async () => {
    const reg = new ChannelRegistry();
    const good = makePlugin("slack");
    const bad = makePlugin("discord", {
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    reg.register(good);
    reg.register(bad);

    const ctx = makeCtx();
    const configs = { slack: { token: "abc" }, discord: { token: "xyz" } };

    // Should NOT throw even though discord fails
    await expect(reg.startAll(configs, ctx)).resolves.toBeUndefined();

    expect(good.start).toHaveBeenCalledWith({
      ...ctx,
      config: { token: "abc" },
    });
    expect(bad.start).toHaveBeenCalled();
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining("discord failed to start"),
    );
  });

  it("startAll passes empty config when channel has no config entry", async () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin("slack");
    reg.register(plugin);

    const ctx = makeCtx();
    await reg.startAll({}, ctx);

    expect(plugin.start).toHaveBeenCalledWith({ ...ctx, config: {} });
  });

  it("stopAll stops all channels", async () => {
    const reg = new ChannelRegistry();
    const p1 = makePlugin("slack");
    const p2 = makePlugin("telegram");
    reg.register(p1);
    reg.register(p2);

    await reg.stopAll();

    expect(p1.stop).toHaveBeenCalled();
    expect(p2.stop).toHaveBeenCalled();
  });

  it("stopAll logs failures but does not throw", async () => {
    const reg = new ChannelRegistry();
    const good = makePlugin("slack");
    const bad = makePlugin("discord", {
      stop: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });

    reg.register(good);
    reg.register(bad);

    // Need to startAll first to set the logger
    const ctx = makeCtx();
    await reg.startAll({}, ctx);

    await expect(reg.stopAll()).resolves.toBeUndefined();
    expect(good.stop).toHaveBeenCalled();
    expect(bad.stop).toHaveBeenCalled();
  });
});
