import type {
  AuthReport,
  AuthResolveContext,
  ListModesOptions,
  ProviderModel,
  ProviderModule,
  SessionContext,
} from "../../types.js";
import { ensureCommandResolvable } from "../../utils/binary.js";
import type { AcpSessionDeps, AcpTransformers } from "./session.js";

/**
 * Configuration for a generic ACP-backed provider. The canonical use is the
 * config-extend `extends: "acp"` form, but any code can build one directly:
 *
 * ```ts
 * registerProvider(acpProvider({ id: "gemini", command: ["gemini", "--acp"] }));
 * ```
 */
export interface AcpProviderConfig {
  /** Unique provider id. */
  id: string;
  /** Command to spawn the ACP agent: [binary, ...args]. */
  command: string[];
  /** Environment overlay applied to every spawn. */
  env?: Record<string, string>;
  /** Display label (informational). */
  label?: string;
  /** Static model list surfaced via listModels(). */
  models?: ProviderModel[];
  /** Default mode id applied on session creation. */
  modeId?: string;
  /** Per-agent quirk transformers (modes / modeId). */
  transformers?: AcpTransformers;
}

async function resolveAcpAuth(
  config: AcpProviderConfig,
  authCtx?: AuthResolveContext,
): Promise<AuthReport> {
  const binary = authCtx?.command ?? config.command[0]!;
  try {
    const resolved = await ensureCommandResolvable(binary);
    return {
      providerType: config.id,
      binary: { installed: true, resolvedPath: resolved.bin },
      options: [],
      source: "filesystem",
    };
  } catch (err) {
    return {
      providerType: config.id,
      binary: { installed: false, error: err instanceof Error ? err.message : String(err) },
      options: [],
      source: "filesystem",
    };
  }
}

/** Build a generic ACP-backed `ProviderModule`. */
export function acpProvider(config: AcpProviderConfig): ProviderModule {
  const deps: AcpSessionDeps = {
    provider: config.id,
    command: config.command,
    ...(config.env ? { env: config.env } : {}),
    ...(config.modeId ? { modeId: config.modeId } : {}),
    ...(config.transformers ? { transformers: config.transformers } : {}),
  };

  const provider: ProviderModule = {
    type: config.id,
    capabilities: {
      sessions: true,
      modelDiscovery: Boolean(config.models),
      quotaProbing: false,
      mcp: false,
      skills: false,
      instructions: false,
      workspace: true,
      planMode: false,
      concurrentSend: false,
      cancelQueuedMessage: false,
      stopTask: false,
      modes: true,
      // Real capability set is negotiated at the ACP initialize handshake.
      dynamicCapabilities: true,
    },
    // Session machinery (+ the ACP SDK it dynamically imports) loads only when
    // an ACP provider is actually invoked — index.ts stays a light leaf.
    execute: async (ctx) => (await import("./session.js")).runAcpExecute(deps, ctx),
    createSession: async (ctx) => (await import("./session.js")).createAcpSession(deps, ctx),
    resolveAuth: (authCtx) => resolveAcpAuth(config, authCtx),
    listModes: async (opts?: ListModesOptions) =>
      (await import("./session.js")).listAcpModes(deps, opts as SessionContext | undefined),
  };

  if (config.models) {
    const models = config.models;
    provider.listModels = async () => models;
  }

  return provider;
}
