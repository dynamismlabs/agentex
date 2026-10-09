import { describe, expect, it, vi } from "vitest";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { codexRateLimits } from "../../src/providers/codex/transcript-normalize.js";
import type { RateLimitUpdate } from "../../src/types.js";
const now = Date.parse("2026-10-09T10:00:00Z");
const stamp = (offset = 0) => new Date(now + offset).toISOString();
function update(id: string, offset = 0, accountId = "a", mode: "merge" | "replace" = "merge"): RateLimitUpdate {
  return { mode, snapshot: { provider: "p", accountId, observedAt: stamp(offset), buckets: [{ id, owner: { kind: "account", id: accountId }, applicability: { kind: "provider_pool", pool: id }, usedPercent: 40, observedAt: stamp(offset) }] } };
}

describe("independent telemetry state", () => {
  it("updates Codex spend-control enforcement across partial metric changes without refreshing unrelated buckets", () => {
    const store = new TelemetryStore();
    store.updateRates(codexRateLimits({ rateLimitsByLimitId: {
      controlled: { limitId: "controlled", spendControlReached: true, individualLimit: null, primary: { usedPercent: 3 } },
      unrelated: { limitId: "unrelated", primary: { usedPercent: 17 } },
    } }, stamp())!);
    store.updateRates(codexRateLimits({ rateLimits: {
      limitId: "controlled", spendControlReached: false, individualLimit: { remainingPercent: 80 },
    } }, stamp(1000))!);
    const buckets = store.rateLimits.getSnapshot({ now: now + 1000 }).value!.buckets;
    expect(buckets.find((bucket) => bucket.id === "controlled:enforcement")).toMatchObject({
      enforcement: { allowed: true }, observedAt: stamp(1000),
    });
    expect(buckets.find((bucket) => bucket.id === "controlled:individualLimit")?.usedPercent).toBe(20);
    expect(buckets.find((bucket) => bucket.id === "unrelated:primary")).toMatchObject({ usedPercent: 17, observedAt: stamp() });
    store.updateRates(codexRateLimits({ rateLimits: {
      limitId: "controlled", spendControlReached: true, individualLimit: null,
    } }, stamp(2000))!);
    const next = store.rateLimits.getSnapshot({ now: now + 2000 }).value!.buckets;
    expect(next.find((bucket) => bucket.id === "controlled:enforcement")?.enforcement?.allowed).toBe(false);
    expect(next.find((bucket) => bucket.id === "controlled:individualLimit")).toBeUndefined();
  });
  it("distinguishes unsupported, unobserved, unavailable, measured zero, empty and stale", () => {
    const unsupported = new TelemetryStore();
    expect(unsupported.context.getSnapshot().status).toBe("unsupported");
    const store = new TelemetryStore("supported", "supported");
    expect(store.context.getSnapshot().status).toBe("unobserved");
    store.unavailableRates("temporarily unavailable");
    expect(store.rateLimits.getSnapshot().status).toBe("unavailable");
    store.setContext({ usedTokens: 0, capacityTokens: 100, usedPercent: 0, observedAt: stamp() });
    expect(store.context.getSnapshot({ now })).toMatchObject({ status: "fresh", value: { usedTokens: 0 } });
    expect(store.context.getSnapshot({ now: now + 61_000 }).status).toBe("stale");
    store.updateRates({ mode: "replace", snapshot: { provider: "p", observedAt: stamp(), buckets: [] } });
    expect(store.rateLimits.getSnapshot({ now })).toMatchObject({ status: "fresh", value: { buckets: [] } });
  });
  it("partial updates neither refresh unrelated buckets nor delete them", () => {
    const store = new TelemetryStore("unknown", "unknown");
    store.updateRates(update("account")); store.updateRates(update("model-pool", 70_000));
    const result = store.rateLimits.getSnapshot({ now: now + 70_000 });
    expect(result.status).toBe("stale");
    expect(result.value?.buckets.map((b) => [b.id, b.stale, b.observedAt])).toEqual([["account", true, stamp()], ["model-pool", false, stamp(70_000)]]);
    const partial = update("model-pool", 80_000); partial.removedBucketIds = ["account"];
    store.updateRates(partial);
    expect(store.rateLimits.getSnapshot({ now: now + 80_000 }).value?.buckets.map((b) => b.id)).toEqual(["model-pool"]);
  });
  it("applies out-of-order partial data per bucket and rejects older removals", () => {
    const store = new TelemetryStore();
    store.updateRates(update("first", 30_000));
    store.updateRates(update("second", 20_000));
    const older = update("second", 10_000);
    older.removedBucketIds = ["first"];
    older.snapshot.buckets[0]!.usedPercent = 99;
    store.updateRates(older);
    expect(store.rateLimits.getSnapshot({ now: now + 30_000 }).value).toMatchObject({
      observedAt: stamp(30_000),
      buckets: [{ id: "first", usedPercent: 40 }, { id: "second", usedPercent: 40 }],
    });
  });
  it("clears only authoritative native collections and prevents older data reviving them", () => {
    const store = new TelemetryStore();
    const scoped = update("family"); scoped.snapshot.buckets[0]!.collectionId = "model_scoped";
    store.updateRates(scoped); store.updateRates(update("account"));
    const empty = update("unused", 1000); empty.snapshot.buckets = []; empty.replacedCollectionIds = ["model_scoped"];
    store.updateRates(empty);
    store.updateRates(scoped);
    expect(store.rateLimits.getSnapshot({ now: now + 1000 }).value?.buckets.map((bucket) => bucket.id)).toEqual(["account"]);
    const newer = update("family", 2000); newer.snapshot.buckets[0]!.collectionId = "model_scoped";
    store.updateRates(newer);
    store.updateRates(empty);
    expect(store.rateLimits.getSnapshot({ now: now + 2000 }).value?.buckets.map((bucket) => bucket.id)).toEqual(["account", "family"]);
    const removed = update("unused", 3000); removed.snapshot.buckets = []; removed.removedBucketIds = ["family"];
    store.updateRates(removed); store.updateRates(newer);
    expect(store.rateLimits.getSnapshot({ now: now + 3000 }).value?.buckets.map((bucket) => bucket.id)).toEqual(["account"]);
  });
  it("reset expiry preserves the last measured percent and original timestamp", () => {
    const store = new TelemetryStore(); const row = update("p"); row.snapshot.buckets[0]!.resetAt = stamp(1000); store.updateRates(row);
    expect(store.rateLimits.getSnapshot({ now: now + 2000, maxAgeMs: Infinity }).value?.buckets[0]).toMatchObject({ stale: true, usedPercent: 40, observedAt: stamp() });
  });
  it("scope changes and concurrent sessions cannot leak or overwrite account data", () => {
    const a = new TelemetryStore(), b = new TelemetryStore(); a.updateRates(update("a-pool")); b.updateRates(update("b-pool", 0, "b"));
    expect(a.rateLimits.getSnapshot({ now }).value?.authContextId).not.toBe(b.rateLimits.getSnapshot({ now }).value?.authContextId);
    a.updateRates(update("new-account", 0, "c"));
    expect(a.rateLimits.getSnapshot({ now }).value?.buckets.map((x) => x.id)).toEqual(["new-account"]);
    expect(b.rateLimits.getSnapshot({ now }).value?.accountId).toBe("b");
    a.resetRates(); expect(a.rateLimits.getSnapshot({ now }).value).toBeNull();
  });
  it("snapshot reads perform no request; explicit concurrent refreshes share a request", async () => {
    const store = new TelemetryStore("supported", "supported"); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = vi.fn(async () => { await gate; store.updateRates(update("p")); });
    store.setRateLimitRefresh(refresh);
    store.rateLimits.getSnapshot(); store.context.getSnapshot(); expect(refresh).not.toHaveBeenCalled();
    const first = store.rateLimits.refresh!(), second = store.rateLimits.refresh!();
    expect(first).toBe(second); expect(refresh).toHaveBeenCalledTimes(1); release(); await first;
    expect(store.rateLimits.getSnapshot({ now }).value?.buckets).toHaveLength(1);
    store.close(); await store.rateLimits.refresh!(); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("marks compaction/model invalidation stale until a new effective-context observation", () => {
    const store = new TelemetryStore(); store.setContext({ model: "m1", usedTokens: 90, capacityTokens: 100, observedAt: stamp() });
    store.invalidateContext("compact"); expect(store.context.getSnapshot({ now }).status).toBe("stale");
    store.setContext({ model: "m2", usedTokens: 10, capacityTokens: 200, observedAt: stamp(1) });
    expect(store.context.getSnapshot({ now: now + 1 })).toMatchObject({ status: "fresh", value: { usedTokens: 10, capacityTokens: 200 } });
    store.setContext({ usedTokens: 99, observedAt: stamp(-1) });
    expect(store.context.getSnapshot({ now }).value?.usedTokens).toBe(10);
  });
  it("does not replace or invalidate root context with a child session's model/context", () => {
    const store = new TelemetryStore();
    store.setContext({ model: "root", usedTokens: 20, capacityTokens: 100, observedAt: stamp() });
    const base = { providerType: "claude", timestamp: stamp(1), sessionId: "s", messageId: null, eventId: null, turnId: null, parentToolCallId: "child-tool", raw: {} };
    store.observe({ ...base, type: "system", subtype: "init", model: "child", cwd: null, tools: [], permissionMode: null });
    store.observe({ ...base, type: "context_usage", usage: { model: "child", usedTokens: 999, observedAt: stamp(1) } });
    expect(store.context.getSnapshot({ now: now + 1 })).toMatchObject({ status: "fresh", value: { model: "root", usedTokens: 20 } });
  });
  it("protects cache from consumer mutations and retains stale data on refresh failure", async () => {
    const store = new TelemetryStore(); store.updateRates(update("p"));
    store.rateLimits.getSnapshot({ now }).value!.buckets[0]!.usedPercent = 0;
    expect(store.rateLimits.getSnapshot({ now }).value?.buckets[0]?.usedPercent).toBe(40);
    store.setRateLimitRefresh(async () => { throw new Error("credential details must not escape"); });
    const result = await store.rateLimits.refresh!();
    expect(result.status).toBe("unavailable"); expect(result.value?.buckets[0]?.stale).toBe(true); expect(result.reason).not.toContain("credential");
  });
});
