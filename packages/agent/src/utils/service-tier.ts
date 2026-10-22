import type { ExecutionContext, ExecutionResult, ServiceTierState, StreamEvent } from "../types.js";
import type { ResolvedBinary } from "./binary.js";
import { runChildProcess } from "./process.js";

import { ServiceTierConfigurationError } from "../types.js";
export { ServiceTierConfigurationError } from "../types.js";

export function validateServiceTier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z]/.test(value) || /[^a-z0-9_-]/.test(value)) {
    throw new ServiceTierConfigurationError("invalid_tier", "serviceTier must be a nonempty provider tier id (for example default or fast)");
  }
  return value;
}

export function versionAtLeast(version: string | null, minimum: [number, number, number]): boolean {
  const parts = version?.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== minimum[i]!) return parts[i]! > minimum[i]!;
  }
  return true;
}

export async function serviceTierRuntimeVersion(binary: ResolvedBinary, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<string | null> {
  const result = await runChildProcess({ runId: "service-tier-version", command: binary.bin,
    args: [...binary.prefixArgs, "--version"], cwd, env, timeoutSec: 5, graceSec: 1, signal });
  return result.exitCode === 0 ? (result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
}

export function serviceTierEvent(providerType: string, update: Partial<ServiceTierState>, sessionId: string | null = null): StreamEvent {
  return { type: "service_tier", update, providerType, sessionId, timestamp: new Date().toISOString(),
    messageId: null, eventId: null, turnId: null, parentToolCallId: null, raw: {} };
}

export class ServiceTierObserver {
  private state: ServiceTierState;
  private observed: boolean;
  constructor(requested?: string) {
    this.state = { requested: requested ?? null, selected: null, effective: null, reason: null };
    this.observed = requested !== undefined;
  }
  reset(): void { this.state = { ...this.state, effective: null, reason: null }; }
  observe(event: StreamEvent): void {
    if (event.parentToolCallId) return;
    if (event.type === "turn_start") this.reset();
    if (event.type === "service_tier") {
      this.observed = true;
      this.state = { ...this.state, ...event.update, requested: this.state.requested };
    }
  }
  snapshot(): ServiceTierState | undefined { return this.observed ? { ...this.state } : undefined; }
}

export async function observeServiceTierExecution(ctx: ExecutionContext, execute: (ctx: ExecutionContext) => Promise<ExecutionResult>): Promise<ExecutionResult> {
  const observer = new ServiceTierObserver(ctx.config?.serviceTier);
  const result = await execute({ ...ctx, onEvent: async (event) => {
    observer.observe(event);
    await ctx.onEvent?.(event);
  } });
  const serviceTier = result.serviceTier ?? observer.snapshot();
  return serviceTier ? { ...result, serviceTier } : result;
}
