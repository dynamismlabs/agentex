/**
 * TTL cache behind `listModels()`.
 *
 * `ListModelsOptions.cacheTtlMs` was part of the public shape long before
 * anything honored it, so callers could pass a TTL and silently get an
 * uncached spawn every time. Model discovery costs a CLI round trip (or
 * several, when a provider has to probe), which is why the option existed.
 *
 * Entries are keyed on the runtime identity that can change the answer —
 * binary override, cwd, and any env the caller passed. Env is folded in
 * because a different credential can yield a different catalog; only the key
 * values participate in a hash along with endpoint/profile/config identity.
 * Credentials are never retained in the cache key or emitted in diagnostics.
 */

import { createHash } from "node:crypto";
import type { ProviderConfig } from "../types.js";
import { buildEnv } from "./env.js";
import { nativeAuthFileIdentity } from "./native-auth-identity.js";

const store = new Map<string, { expiresAt: number; value: unknown }>();

export interface ModelCacheIdentity {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  config?: Pick<ProviderConfig, "command" | "endpoint" | "extraArgs"> | undefined;
}

async function identityKey(provider: string, identity: ModelCacheIdentity): Promise<string> {
  const cwd = identity.cwd ?? process.cwd();
  const effectiveEnv = { ...buildEnv(), ...identity.env };
  const env = Object.entries(effectiveEnv)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const authFiles = await nativeAuthFileIdentity(provider, cwd, effectiveEnv);
  const fingerprint = createHash("sha256").update(JSON.stringify([cwd, identity.config ?? {}, env, authFiles])).digest("hex");
  return `["${provider}",${fingerprint}]`;
}

/**
 * Run `load` at most once per TTL window for the given identity.
 *
 * `cacheTtlMs` of 0 (or undefined) forces a fresh load and refreshes the entry,
 * which is how callers implement an explicit "refresh catalog" action.
 * Rejections are never cached: a discovery failure is usually a transient
 * "CLI is mid-upgrade" and should not pin an error for the whole window.
 */
export async function withModelCache<T>(
  provider: string,
  identity: ModelCacheIdentity,
  cacheTtlMs: number | undefined,
  load: () => Promise<T>,
): Promise<T> {
  const key = await identityKey(provider, identity);
  const ttl = cacheTtlMs ?? 0;
  if (ttl > 0) {
    const hit = store.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  }
  const value = await load();
  if (ttl > 0) store.set(key, { expiresAt: Date.now() + ttl, value });
  else store.delete(key);
  return value;
}

/** Drop cached catalogs. Scoped to one provider when named, otherwise all. */
export function clearModelCache(provider?: string): void {
  if (!provider) {
    store.clear();
    return;
  }
  const prefix = `["${provider}"`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
