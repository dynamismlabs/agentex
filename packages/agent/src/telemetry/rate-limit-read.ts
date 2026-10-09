import { randomUUID } from "node:crypto";
import type { RateLimitReadContext, RateLimitUpdate, TelemetryObservation } from "../types.js";
import { record, textValue } from "../utils/jsonl-lines.js";
import { claudeUsageRateLimits } from "../providers/claude/parse.js";
import { codexRateLimits } from "../providers/codex/transcript-normalize.js";
import { NativeTelemetryError, NativeTelemetryRpc } from "./native-rpc.js";
import { claudeTelemetryArgs, telemetryRuntime, type NativeTelemetryProvider, type TelemetryRuntime } from "./runtime.js";
import { rateLimitTimeout, TelemetryCancelled, TelemetryFlights } from "./single-flight.js";

type Observation = TelemetryObservation<RateLimitUpdate>;
const reads = new TelemetryFlights<Observation>();

/** No completed-data cache. Every explicit read gets a fresh native observation. */
export async function readNativeRateLimits(provider: NativeTelemetryProvider, ctx: RateLimitReadContext = {}): Promise<Observation> {
  const timeoutMs = rateLimitTimeout(ctx.timeoutMs);
  if (ctx.signal?.aborted) return unavailable("Rate-limit read cancelled");
  const started = Date.now();
  try {
    const runtime = await prepareRuntime(provider, ctx, timeoutMs);
    if (runtime.config.endpoint) return unsupported("Custom endpoints do not expose the harness account's plan capacity");
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return unavailable("Rate-limit read timed out");
    return await reads.run(runtime.key, (signal) => readRuntimeRateLimits(runtime, signal), { signal: ctx.signal, timeoutMs: remaining });
  } catch (error) {
    return unavailable(error instanceof TelemetryCancelled ? error.message : "Rate-limit read failed or timed out");
  }
}

async function readRuntimeRateLimits(runtime: TelemetryRuntime, signal: AbortSignal): Promise<Observation> {
  const binary = runtime.binary;
  if (!binary) return unavailable("Selected harness binary is unavailable");
  if (signal.aborted) return unavailable("Rate-limit read cancelled");
  let rpc: NativeTelemetryRpc | undefined;
  try {
    const args = runtime.provider === "claude" ? claudeTelemetryArgs : [...runtime.endpointArgs, "app-server"];
    rpc = new NativeTelemetryRpc(binary.bin, [...binary.prefixArgs, ...args], runtime.cwd, runtime.env, runtime.provider, signal);
    await rpc.request("initialize", runtime.provider === "codex"
      ? { clientInfo: { name: "agentex-rate-limit-read", version: "1" }, capabilities: { experimentalApi: true } } : {}, 60_000);
    return await readRateLimitsFromRpc(runtime.provider, rpc);
  } catch (error) {
    return error instanceof NativeTelemetryError && error.kind === "unsupported"
      ? unsupported("Selected harness runtime does not support account rate-limit reads") : unavailable("Rate-limit read failed or timed out");
  } finally { await rpc?.close(); }
}

/** Scope preparation has no native transport to close, but still consumes the caller's deadline. */
function prepareRuntime(provider: NativeTelemetryProvider, ctx: RateLimitReadContext, timeoutMs: number): Promise<TelemetryRuntime> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ctx.signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanup(); reject(new TelemetryCancelled("aborted")); };
    const timer = setTimeout(() => { cleanup(); reject(new TelemetryCancelled("timeout")); }, timeoutMs); timer.unref();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
    void telemetryRuntime(provider, ctx).then((runtime) => { cleanup(); resolve(runtime); }, (error) => { cleanup(); reject(error); });
  });
}

/** Shared normalization for probes and sessionless reads; no account identity is guessed. */
export async function readRateLimitsFromRpc(provider: NativeTelemetryProvider, rpc: NativeTelemetryRpc, timeoutMs = 60_000): Promise<Observation> {
  let response: Record<string, unknown>;
  let update: RateLimitUpdate | null;
  if (provider === "codex") {
    const auth = await rpc.request("account/read", { refreshToken: false }, timeoutMs);
    const type = textValue(record(auth.account)?.type);
    if (type !== "chatgpt") return unsupported("Codex account rate limits require service-backed ChatGPT authentication");
    response = await rpc.request("account/rateLimits/read", {}, timeoutMs);
    update = codexRateLimits(response, new Date().toISOString(), "replace");
  } else {
    response = await rpc.request("get_usage", { skip_behaviors: true }, timeoutMs);
    if (response.rate_limits_available === false) return unsupported("Plan telemetry is unavailable for the selected Claude auth context");
    update = claudeUsageRateLimits(response, new Date().toISOString(), "replace");
  }
  if (!update) return unavailable("Runtime returned no account rate-limit observation", response.rate_limits_available === true ? "supported" : "unknown");
  update.snapshot.authContextId = randomUUID();
  for (const bucket of update.snapshot.buckets) bucket.stale = bucket.resetAt !== undefined && Date.parse(bucket.resetAt) <= Date.now();
  const stale = update.snapshot.buckets.some((bucket) => bucket.stale);
  return { support: "supported", status: stale ? "stale" : "fresh", value: update, refreshSupported: true };
}

function unsupported(reason: string): Observation { return { support: "unsupported", status: "unsupported", value: null, refreshSupported: false, reason }; }
function unavailable(reason: string, support: Observation["support"] = "unknown"): Observation {
  return { support, status: "unavailable", value: null, refreshSupported: support === "supported", reason };
}
