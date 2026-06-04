import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderModel,
  ProviderModule,
} from "./types.js";
import { getProvider, registerProvider } from "./registry.js";

/**
 * Declarative configuration for a *derived* provider — a new provider id that
 * inherits a built-in provider's behavior with an environment / command / model
 * overlay. The canonical use is BYOK gateways: point Claude at an
 * Anthropic-compatible endpoint (z.ai, Qwen, a local proxy) by extending
 * `"claude"` and setting `env.ANTHROPIC_BASE_URL`, with no new code.
 */
export interface DerivedProviderConfig {
  /** Unique id for the new provider (used with `getProvider`/`registerProvider`). */
  id: string;
  /** A registered provider to inherit from (e.g. "claude", "codex"). For ACP
   *  agents use the config-file loader's `extends: "acp"` form instead. */
  extends: string;
  /** Display label (informational). */
  label?: string;
  /** Description (informational). */
  description?: string;
  /** Override the binary/command the base provider spawns. Per-call
   *  `config.command` still wins. */
  command?: string;
  /** Environment overlay applied to every execute / session / auth / modes /
   *  quota call (e.g. `ANTHROPIC_BASE_URL`). Per-call `ctx.env` overrides it. */
  env?: Record<string, string>;
  /** Replace the model list surfaced by `listModels()`. */
  models?: ProviderModel[];
  /** Default `config.modeId` applied when the caller doesn't set one. */
  modeId?: string;
  /** When `false`, `loadProvidersFromConfig` skips this entry. */
  enabled?: boolean;
}

/** Thrown when a provider config object is malformed. Branch on it; don't parse. */
export class MalformedProviderConfigError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(message);
    this.name = "MalformedProviderConfigError";
    this.path = path;
  }
}

/** Signature of the ACP factory registered by the ACP provider module. */
export type AcpFactory = (config: {
  id: string;
  command: string[];
  env?: Record<string, string>;
  label?: string;
  models?: ProviderModel[];
  modeId?: string;
}) => ProviderModule;

let acpFactory: AcpFactory | null = null;

/**
 * Registered by `@agentex/agent`'s ACP provider module on import, so the
 * config-file loader can build `extends: "acp"` providers without a hard
 * dependency on the ACP SDK at the top of the module graph.
 */
export function registerAcpFactory(factory: AcpFactory): void {
  acpFactory = factory;
}

/** @internal — for tests. */
export function getAcpFactory(): AcpFactory | null {
  return acpFactory;
}

/**
 * Build a derived `ProviderModule` from a base provider plus an overlay. The
 * returned module is NOT auto-registered — pass it to `registerProvider`, or
 * use `loadProvidersFromConfig` which registers for you.
 */
export function defineDerivedProvider(cfg: DerivedProviderConfig): ProviderModule {
  if (!cfg.id || typeof cfg.id !== "string") {
    throw new MalformedProviderConfigError("derived provider requires a non-empty string id");
  }
  if (cfg.extends === "acp") {
    throw new MalformedProviderConfigError(
      `provider "${cfg.id}": extends "acp" is built by loadProvidersFromConfig (or acpProvider() directly), not defineDerivedProvider`,
      cfg.id,
    );
  }
  const base = getProvider(cfg.extends); // throws on unknown base

  const overlayEnv = (env?: Record<string, string>): Record<string, string> => ({
    ...cfg.env,
    ...env,
  });
  const overlayConfig = (config?: ProviderConfig): ProviderConfig => ({
    ...config,
    ...(cfg.command && !config?.command ? { command: cfg.command } : {}),
    ...(cfg.modeId && !config?.modeId ? { modeId: cfg.modeId } : {}),
  });

  const capabilities: ProviderCapabilities = {
    ...base.capabilities,
    ...(cfg.models ? { modelDiscovery: true } : {}),
  };

  const derived: ProviderModule = {
    ...base,
    type: cfg.id,
    capabilities,
    execute: (ctx) =>
      base.execute({ ...ctx, env: overlayEnv(ctx.env), config: overlayConfig(ctx.config) }),
    resolveAuth: (authCtx) =>
      base.resolveAuth({
        ...authCtx,
        env: overlayEnv(authCtx?.env),
        command: authCtx?.command ?? cfg.command,
      }),
  };

  if (base.createSession) {
    const baseCreate = base.createSession.bind(base);
    derived.createSession = (ctx) =>
      baseCreate({ ...ctx, env: overlayEnv(ctx.env), config: overlayConfig(ctx.config) });
  }
  if (cfg.models) {
    const models = cfg.models;
    derived.listModels = async () => models;
  } else if (base.listModels) {
    const baseList = base.listModels.bind(base);
    derived.listModels = (opts) => baseList(opts);
  }
  if (base.listModes) {
    const baseModes = base.listModes.bind(base);
    derived.listModes = (opts) =>
      baseModes({ ...opts, env: overlayEnv(opts?.env), config: overlayConfig(opts?.config) });
  }
  if (base.checkQuota) {
    const baseQuota = base.checkQuota.bind(base);
    derived.checkQuota = (qctx) =>
      baseQuota({ ...qctx, env: overlayEnv(qctx?.env), config: overlayConfig(qctx?.config) });
  }

  return derived;
}

// ---------------------------------------------------------------------------
// Config-file loader
// ---------------------------------------------------------------------------

/** A raw provider entry in a config file (id comes from the map key). */
interface RawProviderEntry {
  extends?: unknown;
  label?: unknown;
  description?: unknown;
  command?: unknown;
  env?: unknown;
  models?: unknown;
  modeId?: unknown;
  enabled?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toCommandArray(command: unknown, path: string): string[] {
  if (typeof command === "string") {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new MalformedProviderConfigError(`${path}.command is empty`, path);
    return parts;
  }
  if (Array.isArray(command) && command.every((c) => typeof c === "string") && command.length > 0) {
    return command as string[];
  }
  throw new MalformedProviderConfigError(
    `${path}.command must be a non-empty string or string[] for an ACP provider`,
    path,
  );
}

function toCommandString(command: unknown, path: string): string | undefined {
  if (command === undefined) return undefined;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    // agentex's `config.command` is a single binary (args go through the agent's
    // own config), so a multi-element array would silently drop everything past
    // the binary — reject it rather than mislead. (ACP providers use the array
    // form via the `extends: "acp"` branch instead.)
    if (command.length === 1 && typeof command[0] === "string") return command[0];
    throw new MalformedProviderConfigError(
      `${path}.command for a non-ACP provider must be a single binary string; got an array of ${command.length} (use extends: "acp" for binary+args)`,
      path,
    );
  }
  return undefined;
}

function validateEnv(env: unknown, path: string): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  if (!isRecord(env)) throw new MalformedProviderConfigError(`${path}.env must be an object`, path);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") {
      throw new MalformedProviderConfigError(`${path}.env.${k} must be a string`, path);
    }
    out[k] = v;
  }
  return out;
}

function validateModels(models: unknown, path: string): ProviderModel[] | undefined {
  if (models === undefined) return undefined;
  if (!Array.isArray(models)) throw new MalformedProviderConfigError(`${path}.models must be an array`, path);
  return models.map((m, i) => {
    if (!isRecord(m) || typeof m["id"] !== "string") {
      throw new MalformedProviderConfigError(`${path}.models[${i}] must have a string id`, path);
    }
    return {
      id: m["id"],
      name: typeof m["name"] === "string" ? m["name"] : m["id"],
      ...(typeof m["provider"] === "string" ? { provider: m["provider"] } : {}),
    };
  });
}

/** Locate the providers map, accepting `{ providers }` or Paseo's
 *  `{ agents: { providers } }` nesting. */
function findProvidersMap(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new MalformedProviderConfigError("config must be an object");
  if (isRecord(raw["providers"])) return raw["providers"];
  if (isRecord(raw["agents"]) && isRecord((raw["agents"] as Record<string, unknown>)["providers"])) {
    return (raw["agents"] as Record<string, unknown>)["providers"] as Record<string, unknown>;
  }
  throw new MalformedProviderConfigError(
    "config must contain a `providers` (or `agents.providers`) object",
  );
}

/**
 * Build provider modules from a config object and (by default) register them.
 * Supports `extends: "<builtin>"` (env/command/model overlay) and
 * `extends: "acp"` (build an ACP provider from `command`). Throws
 * `MalformedProviderConfigError` on a bad shape.
 */
export function loadProvidersFromConfig(
  raw: unknown,
  options?: { register?: boolean },
): ProviderModule[] {
  const register = options?.register ?? true;
  const providersMap = findProvidersMap(raw);
  const built: ProviderModule[] = [];

  for (const [id, value] of Object.entries(providersMap)) {
    const path = `providers.${id}`;
    if (!isRecord(value)) throw new MalformedProviderConfigError(`${path} must be an object`, path);
    const entry = value as RawProviderEntry;

    if (entry.enabled === false) continue;
    if (typeof entry.extends !== "string" || entry.extends.length === 0) {
      throw new MalformedProviderConfigError(`${path}.extends must be a non-empty string`, path);
    }
    const label = typeof entry.label === "string" ? entry.label : undefined;
    const description = typeof entry.description === "string" ? entry.description : undefined;
    const env = validateEnv(entry.env, path);
    const models = validateModels(entry.models, path);
    const modeId = typeof entry.modeId === "string" ? entry.modeId : undefined;

    let provider: ProviderModule;
    if (entry.extends === "acp") {
      if (!acpFactory) {
        throw new MalformedProviderConfigError(
          `${path}: ACP providers require the ACP module — import it (e.g. \`@agentex/agent\`'s acp provider) before loading ACP configs`,
          path,
        );
      }
      provider = acpFactory({
        id,
        command: toCommandArray(entry.command, path),
        ...(env ? { env } : {}),
        ...(label ? { label } : {}),
        ...(models ? { models } : {}),
        ...(modeId ? { modeId } : {}),
      });
    } else {
      const command = toCommandString(entry.command, path);
      provider = defineDerivedProvider({
        id,
        extends: entry.extends,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        ...(models ? { models } : {}),
        ...(modeId ? { modeId } : {}),
      });
    }

    built.push(provider);
  }

  if (register) {
    // Register only after every entry validates, so a bad entry doesn't leave a
    // half-applied config registered.
    for (const provider of built) registerProvider(provider);
  }

  return built;
}
