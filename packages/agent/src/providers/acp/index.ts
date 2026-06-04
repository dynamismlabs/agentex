import type {
  AuthReport,
  AuthResolveContext,
  ExecutionContext,
  ExecutionResult,
  ExecutionStatus,
  ListModesOptions,
  ProviderModel,
  ProviderModule,
  SessionContext,
  TurnResult,
  AgentSession,
} from "../../types.js";
import { ensureCommandResolvable } from "../../utils/binary.js";
import { uuidv7 } from "../../utils/uuid.js";
import { registerAcpFactory } from "../../derived.js";
import {
  createAcpSession,
  listAcpModes,
  type AcpSessionDeps,
  type AcpTransformers,
} from "./session.js";

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

function mapTurnStatus(status: TurnResult["status"]): ExecutionStatus {
  switch (status) {
    case "completed":
    case "max_turns":
    case "max_budget":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "timeout":
      return "timeout";
    default:
      return "completed";
  }
}

async function runAcpExecute(
  deps: AcpSessionDeps,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const model = ctx.model ?? ctx.config?.model ?? null;

  const sessionCtx: SessionContext = {
    ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  const base = {
    runId,
    startedAt,
    signal: null as string | null,
    model,
    summary: null as string | null,
    sessionParams: null as Record<string, unknown> | null,
    sessionDisplayId: null as string | null,
    clearSession: false,
    billingType: null,
  };

  let session: AgentSession | null = null;
  try {
    session = await createAcpSession(deps, sessionCtx);
    const handle = await session.send(ctx.prompt, {
      ...(ctx.config?.timeoutSec ? { timeoutSec: ctx.config.timeoutSec } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const turn = await handle.result;
    const sessionId = session.sessionId;
    await session.close();
    return {
      ...base,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      exitCode: turn.status === "completed" ? 0 : 1,
      status: mapTurnStatus(turn.status),
      errorMessage: turn.errorMessage,
      errorCode: turn.errorCode,
      summary: turn.summary,
      ...(turn.usage ? { usage: turn.usage as ExecutionResult["usage"] } : {}),
      costUsd: turn.costUsd,
      sessionParams: sessionId ? { sessionId } : null,
      sessionDisplayId: sessionId,
    };
  } catch (err) {
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    return {
      ...base,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      exitCode: 1,
      signal: null,
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "acp_error",
      costUsd: null,
    };
  }
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
      modes: true,
      // Real capability set is negotiated at the ACP initialize handshake.
      dynamicCapabilities: true,
    },
    execute: (ctx) => runAcpExecute(deps, ctx),
    createSession: (ctx) => createAcpSession(deps, ctx),
    resolveAuth: (authCtx) => resolveAcpAuth(config, authCtx),
    listModes: (opts?: ListModesOptions) => listAcpModes(deps, opts as SessionContext | undefined),
  };

  if (config.models) {
    const models = config.models;
    provider.listModels = async () => models;
  }

  return provider;
}

// Register the factory so `loadProvidersFromConfig({ extends: "acp" })` can
// build ACP providers. Importing this module is cheap — the SDK is only loaded
// when a session/execute actually runs (dynamic import in session.ts).
registerAcpFactory(acpProvider);
