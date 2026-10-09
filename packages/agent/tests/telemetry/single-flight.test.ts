import { afterEach, expect, it, vi } from "vitest";
import { rateLimitTimeout, TelemetryFlights } from "../../src/telemetry/single-flight.js";
afterEach(() => vi.useRealTimers());
it("caps a shared operation at sixty seconds even when later callers join", async () => {
  vi.useFakeTimers();
  const flights = new TelemetryFlights<{ stopped: boolean }>(); let starts = 0;
  const start = (signal: AbortSignal) => { starts++; return new Promise<{ stopped: boolean }>((resolve) => {
    signal.addEventListener("abort", () => resolve({ stopped: true }), { once: true });
  }); };
  const first = flights.run("scope", start, { timeoutMs: 60_000 });
  await vi.advanceTimersByTimeAsync(50_000);
  const second = flights.run("scope", start, { timeoutMs: 60_000 });
  const settled = Promise.allSettled([first, second]);
  await vi.advanceTimersByTimeAsync(10_000);
  for (const result of await settled) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason.message).toContain("timed out");
  }
  expect(starts).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it("releases failed operations and bounds requested deadlines", async () => {
  const flights = new TelemetryFlights<null>(); let calls = 0;
  const fail = async () => { calls++; throw new Error("failure"); };
  await expect(flights.run("scope", fail, { timeoutMs: 1000 })).rejects.toThrow("failure");
  await expect(flights.run("scope", fail, { timeoutMs: 1000 })).rejects.toThrow("failure");
  expect(calls).toBe(2); expect(rateLimitTimeout()).toBe(10_000); expect(rateLimitTimeout(100_000)).toBe(60_000);
});
