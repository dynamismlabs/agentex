import type { ProviderModule } from "./types.js";
import { claudeProvider } from "./providers/claude/index.js";
import { codexProvider } from "./providers/codex/index.js";
import { openclawProvider } from "./providers/openclaw/index.js";
import { processProvider } from "./providers/process/index.js";
import { geminiProvider } from "./providers/gemini/index.js";
import { cursorProvider } from "./providers/cursor/index.js";
import { opencodeProvider } from "./providers/opencode/index.js";
import { piProvider } from "./providers/pi/index.js";
import { copilotProvider } from "./providers/copilot/index.js";

const providers = new Map<string, ProviderModule>();

// Pre-register built-in providers
providers.set("claude", claudeProvider);
providers.set("codex", codexProvider);
providers.set("openclaw", openclawProvider);
providers.set("process", processProvider);
providers.set("gemini", geminiProvider);
providers.set("cursor", cursorProvider);
providers.set("opencode", opencodeProvider);
providers.set("pi", piProvider);
providers.set("copilot", copilotProvider);

export function getProvider(type: string): ProviderModule {
  const provider = providers.get(type);
  if (!provider) {
    const available = [...providers.keys()].join(", ");
    throw new Error(`Unknown provider type "${type}". Available: ${available}`);
  }
  return provider;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

export function registerProvider(provider: ProviderModule): void {
  providers.set(provider.type, provider);
}
