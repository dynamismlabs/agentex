import type { AdapterModule } from "./types.js";
import { claudeAdapter } from "./adapters/claude/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { openclawAdapter } from "./adapters/openclaw/index.js";
import { processAdapter } from "./adapters/process/index.js";

const adapters = new Map<string, AdapterModule>();

// Pre-register built-in adapters
adapters.set("claude", claudeAdapter);
adapters.set("codex", codexAdapter);
adapters.set("openclaw", openclawAdapter);
adapters.set("process", processAdapter);

export function getAdapter(type: string): AdapterModule {
  const adapter = adapters.get(type);
  if (!adapter) {
    const available = [...adapters.keys()].join(", ");
    throw new Error(`Unknown adapter type "${type}". Available: ${available}`);
  }
  return adapter;
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

export function registerAdapter(adapter: AdapterModule): void {
  adapters.set(adapter.type, adapter);
}
