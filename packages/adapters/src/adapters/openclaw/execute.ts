import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { uuidv7 } from "../../utils/uuid.js";

export async function executeOpenclawAdapter(ctx: ExecutionContext): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const model = ctx.model ?? ctx.config?.model;
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const gatewayUrl = config.command?.trim() || "http://localhost:3001";
  const endpoint = gatewayUrl.replace(/\/$/, "") + "/api/agent/run";

  // Extract session key from session params
  const sessionKey = ctx.sessionParams
    ? (ctx.sessionParams["sessionKey"] as string | undefined) ??
      (ctx.sessionParams["session_key"] as string | undefined) ??
      null
    : null;

  const body = JSON.stringify({
    prompt: ctx.prompt,
    ...(sessionKey ? { sessionKey } : {}),
    ...(model ? { model: model } : {}),
  });

  try {
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    if (config.timeoutSec && config.timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, config.timeoutSec * 1000);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: abortController.signal,
    });

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        runId,
        exitCode: 1,
        signal: null,
        timedOut: false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: `OpenClaw gateway returned ${response.status}: ${errorText}`,
        errorCode: response.status === 401 ? "auth_required" : null,
        costUsd: null,
        model: model ?? null,
        summary: null,
        sessionParams: sessionKey ? { sessionKey, gatewayUrl } : null,
        sessionDisplayId: sessionKey,
        clearSession: false,
        billingType: null,
      };
    }

    const result = await response.json() as Record<string, unknown>;

    const newSessionKey = typeof result["sessionKey"] === "string" ? result["sessionKey"] : sessionKey;
    const summary = typeof result["summary"] === "string" ? result["summary"]
      : typeof result["result"] === "string" ? result["result"]
      : typeof result["output"] === "string" ? result["output"]
      : null;

    // Emit result as stream event
    if (ctx.onEvent && summary) {
      try {
        await ctx.onEvent({
          type: "result",
          text: summary,
          cost: null,
          isError: false,
          timestamp: new Date().toISOString(),
        });
      } catch { /* swallow */ }
    }

    return {
      runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage: null,
      errorCode: null,
      costUsd: typeof result["costUsd"] === "number" ? result["costUsd"] : null,
      model: typeof result["model"] === "string" ? result["model"] : model ?? null,
      summary,
      sessionParams: newSessionKey ? { sessionKey: newSessionKey, gatewayUrl } : null,
      sessionDisplayId: newSessionKey,
      clearSession: false,
      billingType: null,
      raw: result,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        runId,
        exitCode: null,
        signal: null,
        timedOut: true,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: `Timed out after ${config.timeoutSec ?? 0}s`,
        errorCode: "timeout",
        costUsd: null,
        model: model ?? null,
        summary: null,
        sessionParams: sessionKey ? { sessionKey, gatewayUrl } : null,
        sessionDisplayId: sessionKey,
        clearSession: false,
        billingType: null,
      };
    }

    return {
      runId,
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage: err instanceof Error ? err.message : "OpenClaw execution failed",
      errorCode: null,
      costUsd: null,
      model: model ?? null,
      summary: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: false,
      billingType: null,
    };
  }
}
