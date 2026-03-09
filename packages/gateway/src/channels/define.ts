import type { ChannelPlugin } from "../types.js";

export type ChannelPluginDefinition = ChannelPlugin;

export function defineChannel(opts: ChannelPluginDefinition): ChannelPlugin {
  if (!opts.id) {
    throw new Error("Channel plugin must have an id");
  }
  return opts;
}
