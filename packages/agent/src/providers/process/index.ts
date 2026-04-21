import type { AuthResolveContext, AuthReport, ProviderModule } from "../../types.js";
import { executeProcessProvider } from "./execute.js";
import { ensureCommandResolvable } from "../../utils/binary.js";

async function resolveProcessAuth(ctx?: AuthResolveContext): Promise<AuthReport> {
  // Process is a generic runner — the "binary" is user-supplied via config.command.
  // If a command is passed via ctx.command, probe it; otherwise report "unknown".
  if (!ctx?.command) {
    return {
      providerType: "process",
      binary: { installed: false, error: "No command specified (process provider requires config.command)" },
      options: [],
      source: "filesystem",
    };
  }
  try {
    const resolved = await ensureCommandResolvable(ctx.command);
    return {
      providerType: "process",
      binary: { installed: true, resolvedPath: resolved.bin },
      options: [],
      source: "filesystem",
    };
  } catch (err) {
    return {
      providerType: "process",
      binary: { installed: false, error: err instanceof Error ? err.message : String(err) },
      options: [],
      source: "filesystem",
    };
  }
}

export const processProvider: ProviderModule = {
  type: "process",
  capabilities: {
    sessions: false,
    modelDiscovery: false,
    quotaProbing: false,
    mcp: false,
    skills: false,
    instructions: true,
    workspace: true,
  },
  execute: executeProcessProvider,
  resolveAuth: resolveProcessAuth,
};
