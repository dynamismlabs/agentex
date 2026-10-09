import { randomUUID } from "node:crypto";
import type {
  ContextUsage, RateLimitSnapshot, RateLimitUpdate, StreamEvent,
  TelemetryObservation, TelemetryReadOptions, TelemetrySurface,
} from "../types.js";

type Support = TelemetryObservation<unknown>["support"];

/** Each instance belongs to exactly one effective harness/auth transport. No global account cache. */
export class TelemetryStore {
  private contextValue: ContextUsage | null = null;
  private rateValue: RateLimitSnapshot | null = null;
  private contextSupport: Support;
  private rateSupport: Support;
  private contextReason?: string;
  private rateReason?: string;
  private contextInvalid = false;
  private rateUnavailable = false;
  private closed = false;
  private contextRefresh?: () => Promise<void>;
  private rateRefresh?: () => Promise<void>;
  private contextFlight?: Promise<TelemetryObservation<ContextUsage>>;
  private rateFlight?: Promise<TelemetryObservation<RateLimitSnapshot>>;
  private authContextId = randomUUID();
  private authRevision = 0;
  private contextRevision = 0;
  private rateReplacedAt = -Infinity;
  private readonly collectionReplacedAt = new Map<string, number>();
  private readonly bucketRemovedAt = new Map<string, number>();
  get contextScopeVersion(): number { return this.contextRevision; }
  get rateLimitScopeVersion(): number { return this.authRevision; }

  readonly context: TelemetrySurface<ContextUsage> = {
    getSnapshot: (options) => this.getContext(options),
  };
  readonly rateLimits: TelemetrySurface<RateLimitSnapshot> = {
    getSnapshot: (options) => this.getRates(options),
  };

  constructor(contextSupport: Support = "unsupported", rateSupport: Support = "unsupported") {
    this.contextSupport = contextSupport;
    this.rateSupport = rateSupport;
  }

  setContextSupport(support: Support, reason?: string): void {
    this.contextSupport = support;
    this.contextReason = reason;
    if (support === "unsupported") this.contextValue = null;
  }
  setRateLimitSupport(support: Support, reason?: string): void {
    this.rateSupport = support;
    this.rateReason = reason;
    if (support === "unsupported") { this.rateValue = null; this.authRevision++; }
  }
  setContextRefresh(refresh: () => Promise<void>): void {
    this.contextRefresh = refresh;
    this.context.refresh = () => {
      if (this.contextSupport === "unsupported") return Promise.resolve(this.getContext());
      if (this.contextFlight) return this.contextFlight;
      this.contextFlight = this.runRefresh(refresh, () => this.getContext(), (reason) => {
        this.contextReason = reason; this.contextInvalid = true;
      }).finally(() => { this.contextFlight = undefined; });
      return this.contextFlight;
    };
  }
  setRateLimitRefresh(refresh: () => Promise<void>): void {
    this.rateRefresh = refresh;
    this.rateLimits.refresh = () => {
      if (this.rateSupport === "unsupported") return Promise.resolve(this.getRates());
      if (this.rateFlight) return this.rateFlight;
      this.rateFlight = this.runRefresh(refresh, () => this.getRates(), (reason) => {
        this.rateReason = reason; this.rateUnavailable = true;
      }).finally(() => { this.rateFlight = undefined; });
      return this.rateFlight;
    };
  }

  private async runRefresh<T>(refresh: () => Promise<void>, read: () => TelemetryObservation<T>, fail: (reason: string) => void): Promise<TelemetryObservation<T>> {
    if (this.closed) return read();
    try { await refresh(); } catch { fail("Telemetry refresh failed or timed out"); }
    return read();
  }

  observe(event: StreamEvent): void {
    if (this.closed) return;
    if (event.type === "context_usage" && !event.parentToolCallId) {
      this.setContext(event.usage);
    } else if (event.type === "context_usage_invalidated" && !event.parentToolCallId) {
      this.invalidateContext(event.reason);
    } else if (event.type === "rate_limits") {
      this.updateRates(event.update);
    } else if (event.type === "system" && !event.parentToolCallId && event.model && this.contextValue?.model && event.model !== this.contextValue.model) {
      this.invalidateContext("Model changed; waiting for a new context observation");
    }
  }

  setContext(value: ContextUsage): void {
    if (this.closed || (this.contextValue && Date.parse(value.observedAt) < Date.parse(this.contextValue.observedAt))) return;
    this.contextRevision++;
    this.contextValue = structuredClone(value);
    this.contextSupport = "supported";
    this.contextReason = undefined;
    this.contextInvalid = false;
  }
  invalidateContext(reason: string): void {
    this.contextRevision++;
    this.contextInvalid = true;
    this.contextReason = reason;
  }
  unavailableRates(reason: string): void {
    this.rateUnavailable = true;
    this.rateReason = reason;
  }
  updateRates(update: RateLimitUpdate): void {
    if (this.closed) return;
    const next = structuredClone(update.snapshot);
    const scopeChanged = this.rateValue && (next.provider !== this.rateValue.provider
      || (next.accountId !== undefined && this.rateValue.accountId !== undefined && next.accountId !== this.rateValue.accountId));
    if (scopeChanged) { this.authContextId = randomUUID(); this.authRevision++; }
    next.authContextId = this.authContextId;
    if (update.mode === "replace" && !scopeChanged && this.rateValue && Date.parse(next.observedAt) < Date.parse(this.rateValue.observedAt)) return;
    if (update.mode === "merge" && this.rateValue && !scopeChanged) {
      const buckets = new Map(this.rateValue.buckets.map((b) => [b.id, b]));
      const observedTime = Date.parse(next.observedAt);
      for (const collectionId of update.replacedCollectionIds ?? []) {
        if (observedTime < this.rateReplacedAt || observedTime < (this.collectionReplacedAt.get(collectionId) ?? -Infinity)) continue;
        this.collectionReplacedAt.set(collectionId, observedTime);
        for (const [id, bucket] of buckets) {
          if (bucket.collectionId === collectionId && Date.parse(bucket.observedAt) <= observedTime) buckets.delete(id);
        }
      }
      for (const id of update.removedBucketIds ?? []) {
        const old = buckets.get(id);
        if (observedTime >= this.rateReplacedAt && observedTime >= (this.bucketRemovedAt.get(id) ?? -Infinity)
          && (!old || observedTime >= Date.parse(old.observedAt))) {
          buckets.delete(id);
          this.bucketRemovedAt.set(id, observedTime);
        }
      }
      for (const b of next.buckets) {
        const old = buckets.get(b.id);
        const bucketTime = Date.parse(b.observedAt);
        if (bucketTime < this.rateReplacedAt || bucketTime < (this.bucketRemovedAt.get(b.id) ?? -Infinity)
          || (b.collectionId && bucketTime < (this.collectionReplacedAt.get(b.collectionId) ?? -Infinity))) continue;
        if (!old || bucketTime >= Date.parse(old.observedAt)) {
          buckets.set(b.id, b);
          this.bucketRemovedAt.delete(b.id);
        }
      }
      const global = Date.parse(next.observedAt) >= Date.parse(this.rateValue.observedAt)
        ? { ...this.rateValue, ...next } : this.rateValue;
      this.rateValue = { ...global, buckets: [...buckets.values()] };
    } else {
      this.rateValue = next;
      this.collectionReplacedAt.clear();
      this.bucketRemovedAt.clear();
      this.rateReplacedAt = update.mode === "replace" ? Date.parse(next.observedAt) : -Infinity;
      for (const id of update.replacedCollectionIds ?? []) this.collectionReplacedAt.set(id, Date.parse(next.observedAt));
      for (const id of update.removedBucketIds ?? []) this.bucketRemovedAt.set(id, Date.parse(next.observedAt));
    }
    this.rateSupport = "supported";
    this.rateReason = undefined;
    this.rateUnavailable = false;
  }
  /** Auth-change notification invalidates all account observations on this transport. */
  resetRates(): void {
    this.authRevision++;
    this.authContextId = randomUUID();
    this.rateValue = null;
    this.rateReplacedAt = -Infinity;
    this.collectionReplacedAt.clear();
    this.bucketRemovedAt.clear();
    this.rateSupport = "unknown";
    this.rateUnavailable = false;
    this.rateReason = "Authentication changed; refresh to observe the new account";
  }
  close(): void {
    this.closed = true;
    this.contextInvalid = true;
    this.rateUnavailable = true;
    this.contextReason = this.rateReason = "Session transport is closed";
  }

  private getContext(options: TelemetryReadOptions = {}): TelemetryObservation<ContextUsage> {
    const value = this.contextValue ? structuredClone(this.contextValue) : null;
    return {
      support: this.contextSupport,
      status: this.contextSupport === "unsupported" ? "unsupported"
        : this.contextReason && !value ? "unavailable" : !value ? "unobserved"
        : this.contextInvalid || isStale(value.observedAt, options) ? "stale" : "fresh",
      value,
      refreshSupported: Boolean(this.contextRefresh) && !this.closed && this.contextSupport === "supported",
      ...(this.contextReason ? { reason: this.contextReason } : {}),
    };
  }
  private getRates(options: TelemetryReadOptions = {}): TelemetryObservation<RateLimitSnapshot> {
    const value = this.rateValue ? structuredClone(this.rateValue) : null;
    if (value) for (const b of value.buckets) {
      b.stale = this.rateUnavailable || isStale(b.observedAt, options, b.resetAt);
    }
    return {
      support: this.rateSupport,
      status: this.rateSupport === "unsupported" ? "unsupported"
        : this.rateUnavailable ? "unavailable" : !value ? "unobserved"
        : value.buckets.some((b) => b.stale) || isStale(value.observedAt, options) ? "stale" : "fresh",
      value,
      refreshSupported: Boolean(this.rateRefresh) && !this.closed && this.rateSupport === "supported",
      ...(this.rateReason ? { reason: this.rateReason } : {}),
    };
  }
}

function isStale(observedAt: string, options: TelemetryReadOptions, resetAt?: string): boolean {
  const now = options.now ?? Date.now();
  const age = options.maxAgeMs ?? 60_000;
  return !Number.isFinite(Date.parse(observedAt)) || now - Date.parse(observedAt) > age
    || (resetAt !== undefined && Date.parse(resetAt) <= now);
}
