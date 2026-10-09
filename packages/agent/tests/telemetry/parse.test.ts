import { describe, expect, it } from "vitest";
import { codexContextUsage, codexRateLimits, codexLineToStreamEvents } from "../../src/providers/codex/transcript-normalize.js";
import { parseCodexStreamLines } from "../../src/providers/codex/parse.js";
import { claudeContextUsage, claudeRateLimitEvent, claudeUsageRateLimits, parseStreamLine } from "../../src/providers/claude/parse.js";
import { mapAcpUpdate } from "../../src/providers/acp/parse.js";
import { parseCodexLine } from "../../src/providers/codex/transcript.js";

const time = "2026-10-09T10:00:00.000Z";

describe("current context, independent from cumulative usage", () => {
  it("uses Codex last.totalTokens without adding totals or cached tokens again", () => {
    const value = codexContextUsage({ total: { totalTokens: 900_000 }, last: { totalTokens: 40_000, inputTokens: 39_000, cachedInputTokens: 30_000, outputTokens: 1000 }, modelContextWindow: 200_000 }, time);
    expect(value).toEqual({ usedTokens: 40_000, capacityTokens: 200_000, usedPercent: 20, observedAt: time });
    expect(codexContextUsage({ total: { totalTokens: 999 }, modelContextWindow: null }, time)).toBeNull();
  });
  it("emits replacement observations after compaction and capacity/model changes", () => {
    const payload = (used: number, capacity: number, model: string) => JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "root", model, tokenUsage: { last: { totalTokens: used }, modelContextWindow: capacity } } });
    const before = parseCodexStreamLines(payload(80_000, 100_000, "old-model"))[0];
    const after = parseCodexStreamLines(payload(20_000, 400_000, "future-model"))[0];
    expect(before).toMatchObject({ type: "context_usage", usage: { usedPercent: 80 } });
    expect(after).toMatchObject({ type: "context_usage", usage: { usedTokens: 20_000, capacityTokens: 400_000, model: "future-model", usedPercent: 5 }, sessionId: "root" });
  });
  it.each([undefined, null, {}, { last: { totalTokens: "40" } }, { last: { totalTokens: -1 }, modelContextWindow: NaN }])("keeps missing/malformed Codex metrics unknown: %j", (source) => {
    expect(codexContextUsage(source, time)).toBeNull();
  });
  it("preserves reported zero and avoids division by a zero capacity", () => {
    expect(codexContextUsage({ last: { totalTokens: 0 }, modelContextWindow: 0 }, time)).toEqual({ usedTokens: 0, capacityTokens: 0, observedAt: time });
  });
  it("keeps overflowing derived values unknown rather than emitting infinities", () => {
    expect(codexContextUsage({ last: { totalTokens: 1e308 }, modelContextWindow: 1e-308 }, time)?.usedPercent).toBeUndefined();
    expect(codexRateLimits({ rateLimits: { limitId: "p", primary: { usedPercent: 1, windowDurationMins: 1e308 }, individualLimit: { remainingPercent: 101 } } }, time)?.snapshot.buckets).toMatchObject([
      { id: "p:primary", usedPercent: 1 }, { id: "p:individualLimit" },
    ]);
    expect(codexRateLimits({ rateLimits: { primary: { windowDurationMins: 1e308 } } }, time)?.snapshot.buckets[0]?.durationMs).toBeUndefined();
  });
  it("uses Claude's effective window and native estimate, not cumulative modelUsage", () => {
    expect(claudeContextUsage({ totalTokens: 120_000, maxTokens: 1_000_000, rawMaxTokens: 200_000, percentage: 60, model: "future" }, time)).toMatchObject({ usedTokens: 120_000, capacityTokens: 200_000, usedPercent: 60, model: "future", observedAt: time });
    expect(claudeContextUsage({ modelUsage: { model: { inputTokens: 999 } } }, time)).toBeNull();
  });
  it("keeps ACP cumulative session cost separate and accepts reported zero", () => {
    const event = mapAcpUpdate({ sessionUpdate: "usage_update", used: 0, size: 1000, cost: { amount: 4.2, currency: "EUR" } }, { provider: "custom-acp", sessionId: "s", timestamp: time });
    expect(event).toMatchObject({ type: "context_usage", usage: { usedTokens: 0, capacityTokens: 1000, usedPercent: 0, sessionCost: { amount: 4.2, currency: "EUR" }, observedAt: time } });
    for (const used of [-1, NaN, Infinity, "0", null]) expect(mapAcpUpdate({ sessionUpdate: "usage_update", used, size: 1000 }, { provider: "p", sessionId: "s", timestamp: time })?.type).toBe("unknown");
  });
  it("preserves replay source time and normalizes Codex rollout token_count", () => {
    const line = parseCodexLine(JSON.stringify({ timestamp: time, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 800_000 }, last_token_usage: { total_tokens: 5000 }, model_context_window: 100_000 } } }))!;
    const events = codexLineToStreamEvents(line, { sessionId: "restored" });
    expect(events[0]).toMatchObject({ type: "context_usage", timestamp: time, usage: { usedTokens: 5000, usedPercent: 5, observedAt: time } });
    const claude = parseStreamLine(JSON.stringify({ type: "assistant", timestamp: time, message: { content: [{ type: "text", text: "report" }] }, context_usage: { model: "m", total_tokens: 123, raw_max_tokens: 1000, percentage: 12 } }));
    expect(claude.map((e) => e.type)).toEqual(["assistant", "context_usage"]);
    expect(claude[1]).toMatchObject({ timestamp: time, usage: { observedAt: time, usedTokens: 123 } });
  });
});

describe("independent provider buckets", () => {
  it.each([true, false])("preserves Codex spend-control enforcement (%s) independently of numerical windows", (reached) => {
    const result = codexRateLimits({ rateLimitsByLimitId: {
      controlled: { limitId: "controlled", spendControlReached: reached, individualLimit: null, primary: { usedPercent: 3 } },
      unrelated: { limitId: "unrelated", primary: { usedPercent: 17 } },
    } }, time)!;
    expect(result.snapshot.buckets.find((bucket) => bucket.id === "controlled:enforcement")).toMatchObject({
      enforcement: { allowed: !reached }, observedAt: time,
      applicability: { kind: "provider_pool", pool: "controlled" },
      metadata: { spendControlReached: reached },
    });
    expect(result.snapshot.buckets.find((bucket) => bucket.id === "controlled:primary")?.usedPercent).toBe(3);
    expect(result.snapshot.buckets.find((bucket) => bucket.id === "unrelated:primary")?.enforcement).toBeUndefined();
  });
  it("keeps spend-control state observable when individual-limit metrics appear or disappear", () => {
    for (const individualLimit of [null, { remainingPercent: 80 }]) {
      const result = codexRateLimits({ rateLimits: {
        limitId: "controlled", spendControlReached: true, individualLimit,
        rateLimitReachedType: "workspace_owner_spend_control_reached",
        credits: { hasCredits: true },
      } }, time)!;
      expect(result.snapshot.buckets.find((bucket) => bucket.id === "controlled:enforcement")?.enforcement).toEqual({
        allowed: false, status: "workspace_owner_spend_control_reached", reason: "workspace_owner_spend_control_reached",
      });
    }
    for (const spendControlReached of [undefined, null, "true"]) {
      const result = codexRateLimits({ rateLimits: { limitId: "p", spendControlReached, primary: { usedPercent: 1 } } }, time)!;
      expect(result.snapshot.buckets).toHaveLength(1);
      expect(result.snapshot.buckets[0]?.enforcement).toBeUndefined();
    }
  });
  it("preserves all Codex pools, arbitrary windows/durations, credits and enforcement", () => {
    const result = codexRateLimits({ accountId: "account-a", ordinaryUsageAllowed: false, rateLimitsByLimitId: {
      general: { limitId: "general", limitName: "General", primary: { usedPercent: 0, windowDurationMins: 17, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 103, windowDurationMins: 10800 }, credits: { hasCredits: false, unlimited: false, balance: "0.0" }, rateLimitReachedType: "workspace_member_usage_limit_reached" },
      "new/pool": { limitId: "new/pool", tertiary: { usedPercent: 49, windowDurationMins: 71 }, nativeFuture: { hello: "world" } },
    } }, time, "replace")!;
    expect(result.snapshot.buckets.map((b) => b.id)).toEqual(["general:primary", "general:secondary", "general:credits", "new%2Fpool:tertiary"]);
    expect(result.snapshot.buckets[0]).toMatchObject({ usedPercent: 0, durationMs: 17 * 60_000, resetAt: new Date(1_800_000_000_000).toISOString(), owner: { kind: "account", id: "account-a" }, applicability: { kind: "provider_pool", pool: "general" }, enforcement: { reason: "workspace_member_usage_limit_reached" } });
    expect(result.snapshot.buckets[1]?.usedPercent).toBe(103);
    expect(result.snapshot.buckets[2]?.credits).toEqual({ hasCredits: false, unlimited: false, balance: "0.0" });
    expect(result.snapshot.ordinaryUsageAllowed).toBe(false);
  });
  it("distinguishes explicit empty Codex data from unavailable data and unknown identity", () => {
    expect(codexRateLimits({}, time)).toBeNull();
    expect(codexRateLimits({ rateLimitsByLimitId: {} }, time, "replace")?.snapshot.buckets).toEqual([]);
    expect(codexRateLimits({ rateLimits: { primary: {} } }, time)?.snapshot.buckets[0]).toMatchObject({ id: "unknown:primary", applicability: { kind: "unknown" } });
    expect(codexRateLimits({ rateLimits: { limitId: "p", secondary: null } }, time)?.removedBucketIds).toContain("p:secondary");
  });
  it("preserves Claude model-family windows and stream fractions above 1", () => {
    const result = claudeRateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.75, resetsAt: 1_800_000_000, unifiedWindows: { five_hour: { utilization: 1.12, resetsAt: 1_790_000_000 }, seven_day: { utilization: 0 }, future_pool: { utilization: 0.6 } }, overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false, errorCode: "credits_required" }, time)!;
    expect(result.snapshot.buckets.map((b) => [b.id, b.usedPercent])).toEqual([["five_hour", 112.00000000000001], ["seven_day", 0], ["future_pool", 60], ["seven_day_opus", 75], ["overage", undefined]]);
    const opus = result.snapshot.buckets.find((b) => b.id === "seven_day_opus")!;
    expect(opus.applicability).toEqual({ kind: "model_family", family: "opus" });
    expect(result.snapshot.buckets[0]?.enforcement).toBeUndefined();
    expect(result.snapshot.buckets.at(-1)?.overage).toEqual({ status: "rejected", reason: "out_of_credits", isUsing: false });
  });
  it("normalizes control percentages without multiplying, preserves future windows, dollars and model labels", () => {
    const result = claudeUsageRateLimits({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 30, used_dollars: 2, limit_dollars: 10, remaining_dollars: 8, locked_reason: "provider_reason" }, seven_day_opus: null, new_pool: { utilization: 9, window_duration_seconds: 37 }, model_scoped: [{ display_name: "Future Model Pool", utilization: 48, resets_at: time }], extra_usage: { is_enabled: false, monthly_limit: 1000, used_credits: 4, utilization: null }, limits: [{ kind: "native", group: "team", scope: "new-model-pool", percent: 66, severity: "warning" }] } }, time)!;
    expect(result.snapshot.buckets[0]).toMatchObject({ usedPercent: 30, used: 2, remaining: 8, limit: 10, unit: "USD", enforcement: { reason: "provider_reason" } });
    expect(result.snapshot.buckets.find((b) => b.id === "new_pool")?.durationMs).toBe(37_000);
    expect(result.snapshot.buckets.find((b) => b.label === "Future Model Pool")?.applicability.kind).toBe("provider_pool");
    expect(result.removedBucketIds).toContain("seven_day_opus");
    expect(claudeUsageRateLimits({ rate_limits: {} }, time)?.mode).toBe("replace");
    expect(claudeUsageRateLimits({ rate_limits: null }, time)).toBeNull();
  });
  it("preserves native currency minor units and authoritative scoped collection semantics", () => {
    const result = claudeUsageRateLimits({ rate_limits: {
      extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 1234, currency: "USD" },
      limits: [{ kind: "weekly_scoped", group: "weekly", percent: 12, severity: "normal", scope: { model: { display_name: "Future family" } } }],
      model_scoped: [],
    } }, time)!;
    expect(result.snapshot.buckets[0]).toMatchObject({ used: 1234, limit: 5000, unit: "USD:minor", overage: { enabled: false } });
    expect(result.snapshot.buckets[1]).toMatchObject({ label: "Future family", collectionId: "limits", usedPercent: 12 });
    expect(result.replacedCollectionIds).toEqual(["limits", "model_scoped"]);
    expect(claudeUsageRateLimits({ rate_limits: { model_scoped: [{ display_name: "Future family", utilization: 3 }] } }, time)?.replacedCollectionIds).toEqual([]);
    expect(claudeUsageRateLimits({ rate_limits: { model_scoped: null, limits: null } }, time)?.replacedCollectionIds).toEqual([]);
  });
  it("keeps legacy rate_limit events plus a separate normalized event, and redacts metadata", () => {
    const events = parseStreamLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", future: { apiKey: "secret", access_token: "secret", nativeValue: 42 }, resetsAt: 1e300 } }));
    expect(events.map((e) => e.type)).toEqual(["rate_limit", "rate_limits"]);
    const update = events.find((e) => e.type === "rate_limits");
    if (update?.type !== "rate_limits") throw new Error("missing update");
    expect(update.update.snapshot.buckets[0]?.usedPercent).toBeUndefined();
    expect(update.update.snapshot.buckets[0]?.resetAt).toBeUndefined();
    expect(JSON.stringify(update.update)).not.toContain("secret");
    expect(update.update.snapshot.buckets[0]?.metadata?.future).toEqual({ nativeValue: 42 });
  });
  it("does not infer Codex enforcement from a percentage when overage may fund requests", () => {
    const events = parseCodexStreamLines(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "p", primary: { usedPercent: 100 }, credits: { hasCredits: true } } } }));
    expect(events[0]).toMatchObject({ type: "rate_limit", status: "unknown" });
    if (events[1]?.type !== "rate_limits") throw new Error("missing capacity");
    expect(events[1].update.snapshot.buckets[0]?.usedPercent).toBe(100);
    expect(events[1].update.snapshot.buckets[0]?.enforcement).toBeUndefined();
  });
});
