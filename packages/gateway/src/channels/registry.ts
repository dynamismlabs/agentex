import type { ChannelPlugin, ChannelContext, Logger } from "../types.js";

export class ChannelRegistry {
  private plugins = new Map<string, ChannelPlugin>();
  private log: Logger | undefined;

  register(plugin: ChannelPlugin, accountId?: string): void {
    this.plugins.set(plugin.id, plugin);
    if (accountId) {
      this.plugins.set(`${plugin.id}:${accountId}`, plugin);
    }
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  getByInstance(
    channelType: string,
    accountId?: string,
  ): ChannelPlugin | undefined {
    if (accountId) {
      return this.plugins.get(`${channelType}:${accountId}`);
    }
    return this.plugins.get(channelType);
  }

  getAll(): ChannelPlugin[] {
    const seen = new Set<ChannelPlugin>();
    const result: ChannelPlugin[] = [];
    for (const plugin of this.plugins.values()) {
      if (!seen.has(plugin)) {
        seen.add(plugin);
        result.push(plugin);
      }
    }
    return result;
  }

  async startAll(
    configs: Record<string, Record<string, unknown>>,
    ctx: Omit<ChannelContext, "config">,
  ): Promise<void> {
    this.log = ctx.log;
    const plugins = this.getAll();
    const results = await Promise.allSettled(
      plugins.map((plugin) => {
        const config = configs[plugin.id] ?? {};
        return plugin.start({ ...ctx, config });
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        ctx.log.error(
          `Channel ${plugins[i]!.id} failed to start: ${String(result.reason)}`,
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    const plugins = this.getAll();
    const results = await Promise.allSettled(
      plugins.map((plugin) => plugin.stop()),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        this.log?.error(
          `Channel ${plugins[i]!.id} failed to stop: ${String(result.reason)}`,
        );
      }
    }
  }
}
