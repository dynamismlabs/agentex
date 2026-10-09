import type { AgentSession, ExecutionContext, ExecutionResult } from "../types.js";
import { TelemetryStore } from "./store.js";

/** Capture provider telemetry even without a subscriber, preserving all accounting/result fields. */
export async function observeExecution(
  ctx: ExecutionContext,
  support: { context: boolean; rates: boolean },
  execute: (ctx: ExecutionContext) => Promise<ExecutionResult>,
  hydrate?: (result: ExecutionResult, store: TelemetryStore) => Promise<void>,
): Promise<ExecutionResult> {
  const store = new TelemetryStore(support.context ? "unknown" : "unsupported", support.rates ? "unknown" : "unsupported");
  const result = await execute({ ...ctx, onEvent: async (event) => {
    store.observe(event);
    await ctx.onEvent?.(event);
  } });
  if (hydrate) await hydrate(result, store).catch(() => {});
  return { ...result, contextUsage: store.context.getSnapshot(), rateLimitSnapshot: store.rateLimits.getSnapshot() };
}

/** Built-in protocols without a verified source explicitly report unsupported. */
export function unsupportedSessionTelemetry<T extends AgentSession>(session: T): T {
  const store = new TelemetryStore();
  Object.defineProperties(session, {
    contextUsage: { value: store.context, enumerable: true },
    rateLimits: { value: store.rateLimits, enumerable: true },
  });
  return session;
}
