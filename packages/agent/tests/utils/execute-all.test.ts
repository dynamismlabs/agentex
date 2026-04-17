import { describe, it, expect, vi } from "vitest";
import { executeAll } from "../../src/utils/execute-all.js";
import type { ProviderModule, ExecutionResult, ExecutionContext } from "../../src/types.js";

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    runId: "test",
    exitCode: 0,
    signal: null,
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 100,
    errorMessage: null,
    errorCode: null,
    costUsd: null,
    model: null,
    summary: "done",
    sessionParams: null,
    sessionDisplayId: null,
    clearSession: false,
    billingType: null,
    ...overrides,
  };
}

function makeProvider(executeFn: (ctx: ExecutionContext) => Promise<ExecutionResult>): ProviderModule {
  return {
    type: "mock",
    capabilities: {
      sessions: false,
      modelDiscovery: false,
      quotaProbing: false,
      mcp: false,
      skills: false,
      instructions: false,
      workspace: false,
    },
    execute: executeFn,
    testEnvironment: async () => ({
      providerType: "mock",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  };
}

describe("executeAll", () => {
  it("returns empty array for empty tasks", async () => {
    const results = await executeAll([]);
    expect(results).toEqual([]);
  });

  it("runs tasks concurrently and returns results in order", async () => {
    const order: number[] = [];
    const provider = makeProvider(async (ctx) => {
      const idx = Number(ctx.prompt);
      // Task 1 finishes first, task 0 finishes second
      await new Promise((r) => setTimeout(r, idx === 0 ? 30 : 10));
      order.push(idx);
      return makeResult({ summary: `result-${idx}` });
    });

    const results = await executeAll([
      { provider, ctx: { prompt: "0" } },
      { provider, ctx: { prompt: "1" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.summary).toBe("result-0");
    expect(results[1]!.summary).toBe("result-1");
    // Task 1 should finish before task 0
    expect(order).toEqual([1, 0]);
  });

  it("resolves string provider names via registry", async () => {
    // "claude" is registered in the registry — execute will fail since no binary,
    // but it proves the name resolved
    const results = await executeAll([
      { provider: "claude", ctx: { prompt: "test", config: { timeoutSec: 1 } } },
    ]);
    expect(results).toHaveLength(1);
    // Should get a result (likely failed since no binary), not a throw
    expect(results[0]!.status).toBeDefined();
  });

  it("cancelOnFailure aborts remaining tasks when one fails", async () => {
    const provider = makeProvider(async (ctx) => {
      if (ctx.prompt === "fail") {
        return makeResult({ status: "failed", errorMessage: "boom" });
      }
      // Slow task — should be aborted
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 5000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
      return makeResult({
        status: ctx.signal?.aborted ? "aborted" : "completed",
        summary: "slow",
      });
    });

    const results = await executeAll(
      [
        { provider, ctx: { prompt: "fail" } },
        { provider, ctx: { prompt: "slow" } },
      ],
      { cancelOnFailure: true },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe("failed");
    expect(results[1]!.status).toBe("aborted");
  });

  it("respects external abort signal", async () => {
    const controller = new AbortController();
    const provider = makeProvider(async (ctx) => {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
      return makeResult({
        status: ctx.signal?.aborted ? "aborted" : "completed",
      });
    });

    // Abort after 20ms
    setTimeout(() => controller.abort(), 20);

    const results = await executeAll(
      [{ provider, ctx: { prompt: "test" } }],
      { signal: controller.signal },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
  });

  it("merges task-level signal with shared signal", async () => {
    const taskController = new AbortController();
    const provider = makeProvider(async (ctx) => {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
      return makeResult({
        status: ctx.signal?.aborted ? "aborted" : "completed",
      });
    });

    // Abort the task-level signal
    setTimeout(() => taskController.abort(), 20);

    const results = await executeAll([
      { provider, ctx: { prompt: "test", signal: taskController.signal } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
  });

  it("handles already-aborted external signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = makeProvider(async (ctx) => {
      return makeResult({
        status: ctx.signal?.aborted ? "aborted" : "completed",
      });
    });

    const results = await executeAll(
      [{ provider, ctx: { prompt: "test" } }],
      { signal: controller.signal },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
  });
});
