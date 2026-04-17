import type { ProviderModel } from "../types.js";

/**
 * Simple in-memory TTL cache for model lists.
 * Each provider creates its own instance.
 */
export class ModelCache {
  private cache: ProviderModel[] | null = null;
  private cachedAt = 0;

  async get(ttlMs: number, fetcher: () => Promise<ProviderModel[]>): Promise<ProviderModel[]> {
    if (ttlMs > 0 && this.cache && Date.now() - this.cachedAt < ttlMs) {
      return this.cache;
    }
    this.cache = await fetcher();
    this.cachedAt = Date.now();
    return this.cache;
  }
}
