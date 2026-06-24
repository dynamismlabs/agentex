import type {
  AuthReport,
  ExecutionContext,
  ExecutionResult,
  ProviderModule,
  SessionCodec,
} from "../../types.js";
import { uuidv7 } from "../../utils/uuid.js";

/**
 * Reusable "remote HTTP agent" adapter — the pattern OpenClaw encodes and the
 * shape any gateway-backed agent reuses: resolve a gateway URL (per-call command
 * override → saved sessionParams → default), round-trip a session key through
 * `sessionParams`, POST the prompt, map 401/403 to an `auth_required` event, and
 * bound the request with an AbortController timeout.
 */
export interface HttpAgentOptions {
  /** Provider id (used on events + the result). */
  providerType: string;
  /** Gateway base URL used when neither `config.command` nor a saved URL is set. */
  defaultBaseUrl: string;
  /** Path appended to the base URL for the run endpoint (e.g. "/api/agent/run"). */
  runPath: string;
  /** Recovery command surfaced on `auth_required` (e.g. "openclaw login"). */
  loginCommand?: string;
  /** Build the JSON request body. Default: `{ prompt, sessionKey?, model? }`. */
  buildBody?: (input: { prompt: string; sessionKey: string | null; model: string | null }) => Record<string, unknown>;
  /** Pull the summary text from the gateway response. Default: summary ?? result ?? output. */
  extractSummary?: (response: Record<string, unknown>) => string | null;
  /** Pull the (possibly new) session key from the response. Default: `response.sessionKey ?? prev`. */
  extractSessionKey?: (response: Record<string, unknown>, prev: string | null) => string | null;
  /** Pull the model id from the response. Default: `response.model ?? fallback`. */
  extractModel?: (response: Record<string, unknown>, fallback: string | null) => string | null;
  /** Pull the cost from the response. Default: `response.costUsd` when numeric. */
  extractCost?: (response: Record<string, unknown>) => number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function defaultSummary(r: Record<string, unknown>): string | null {
  return str(r["summary"]) ?? str(r["result"]) ?? str(r["output"]);
}

/** Resolve the session key from session params (sessionKey / session_key). */
function readSessionKey(sessionParams: Record<string, unknown> | null | undefined): string | null {
  if (!sessionParams) return null;
  return str(sessionParams["sessionKey"]) ?? str(sessionParams["session_key"]);
}

/** Execute a single turn against a remote HTTP agent gateway. */
export async function runHttpAgent(
  opts: HttpAgentOptions,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const runId = ctx.runId ?? uuidv7();
  const model = ctx.model ?? ctx.config?.model ?? null;
  const config = ctx.config ?? {};
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const savedGatewayUrl = str(ctx.sessionParams?.["gatewayUrl"]);
  const gatewayUrl = config.command?.trim() || savedGatewayUrl || opts.defaultBaseUrl;
  const endpoint = gatewayUrl.replace(/\/$/, "") + opts.runPath;

  const sessionKey = readSessionKey(ctx.sessionParams);
  const body = opts.buildBody
    ? opts.buildBody({ prompt: ctx.prompt, sessionKey, model })
    : {
        prompt: ctx.prompt,
        ...(sessionKey ? { sessionKey } : {}),
        ...(model ? { model } : {}),
      };

  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (config.timeoutSec && config.timeoutSec > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, config.timeoutSec * 1000);
  }
  // Chain a caller-supplied signal (a caller abort is distinct from a timeout).
  if (ctx.signal) {
    if (ctx.signal.aborted) abortController.abort();
    else ctx.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const isAuth = response.status === 401 || response.status === 403;
      if (isAuth && ctx.onEvent) {
        try {
          await ctx.onEvent({
            type: "auth_required",
            httpStatus: response.status,
            reason: "unknown",
            loginCommand: opts.loginCommand ?? `${opts.providerType} login`,
            message: errorText || null,
            timestamp: new Date().toISOString(),
            providerType: opts.providerType,
            sessionId: sessionKey ?? null,
            messageId: null,
            eventId: null,
            turnId: null,
            parentToolCallId: null,
            raw: { status: response.status, body: errorText },
          });
        } catch {
          /* swallow */
        }
      }
      return {
        runId,
        exitCode: 1,
        signal: null,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: `${opts.providerType} gateway returned ${response.status}: ${errorText}`,
        errorCode: isAuth ? "auth_required" : null,
        costUsd: null,
        model,
        summary: null,
        sessionParams: sessionKey ? { sessionKey, gatewayUrl } : null,
        sessionDisplayId: sessionKey,
        clearSession: false,
        billingType: null,
      };
    }

    const result = (await response.json()) as Record<string, unknown>;
    const newSessionKey = opts.extractSessionKey
      ? opts.extractSessionKey(result, sessionKey)
      : (str(result["sessionKey"]) ?? sessionKey);
    const summary = (opts.extractSummary ?? defaultSummary)(result);
    const resolvedModel = opts.extractModel
      ? opts.extractModel(result, model)
      : (str(result["model"]) ?? model);
    const costUsd = opts.extractCost
      ? opts.extractCost(result)
      : typeof result["costUsd"] === "number"
        ? (result["costUsd"] as number)
        : null;

    if (ctx.onEvent && summary) {
      try {
        await ctx.onEvent({
          type: "result",
          text: summary,
          costUsd,
          isError: false,
          stopReason: null,
          terminalReason: null,
          numTurns: null,
          durationMs: null,
          timestamp: new Date().toISOString(),
          providerType: opts.providerType,
          sessionId: newSessionKey ?? null,
          messageId: null,
          eventId: null,
          turnId: null,
          parentToolCallId: null,
          raw: result,
        });
      } catch {
        /* swallow */
      }
    }

    return {
      runId,
      exitCode: 0,
      signal: null,
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage: null,
      errorCode: null,
      costUsd,
      model: resolvedModel,
      summary,
      sessionParams: newSessionKey ? { sessionKey: newSessionKey, gatewayUrl } : null,
      sessionDisplayId: newSessionKey,
      clearSession: false,
      billingType: null,
      raw: result,
    };
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (err instanceof Error && err.name === "AbortError") {
      // A timeout and a caller-supplied signal abort both surface as AbortError;
      // distinguish them so consumers can tell a deadline from a cancellation.
      const isTimeout = timedOut;
      return {
        runId,
        exitCode: null,
        signal: null,
        status: isTimeout ? "timeout" : "aborted",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: isTimeout ? `Timed out after ${config.timeoutSec ?? 0}s` : "Aborted by caller",
        errorCode: isTimeout ? "timeout" : "aborted",
        costUsd: null,
        model,
        summary: null,
        sessionParams: sessionKey ? { sessionKey, gatewayUrl } : null,
        sessionDisplayId: sessionKey,
        clearSession: false,
        billingType: null,
      };
    }
    // A transient network error (DNS, reset) is recoverable — preserve the
    // session key / gateway so the caller can resume rather than losing it.
    return {
      runId,
      exitCode: null,
      signal: null,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage: err instanceof Error ? err.message : `${opts.providerType} execution failed`,
      errorCode: null,
      costUsd: null,
      model,
      summary: null,
      sessionParams: sessionKey ? { sessionKey, gatewayUrl } : null,
      sessionDisplayId: sessionKey,
      clearSession: false,
      billingType: null,
    };
  }
}

/** Session codec for HTTP-agent providers — round-trips `{ sessionKey, gatewayUrl }`. */
export const httpAgentSessionCodec: SessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const sessionKey = str(obj["sessionKey"]) ?? str(obj["session_key"]);
    if (!sessionKey) return null;
    const gatewayUrl = str(obj["gatewayUrl"]);
    return { sessionKey, ...(gatewayUrl ? { gatewayUrl } : {}) };
  },
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionKey = str(params["sessionKey"]) ?? str(params["session_key"]);
    if (!sessionKey) return null;
    const gatewayUrl = str(params["gatewayUrl"]);
    return { sessionKey, ...(gatewayUrl ? { gatewayUrl } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return str(params["sessionKey"]) ?? str(params["session_key"]);
  },
};

/** Build a `ProviderModule` for a remote HTTP agent gateway. */
export function httpAgentProvider(opts: HttpAgentOptions): ProviderModule {
  async function resolveAuth(): Promise<AuthReport> {
    // The gateway is a URL, not a local binary, so we can't probe presence here.
    return {
      providerType: opts.providerType,
      binary: { installed: true },
      options: [],
      source: "filesystem",
    };
  }
  return {
    type: opts.providerType,
    capabilities: {
      sessions: false,
      modelDiscovery: false,
      quotaProbing: false,
      mcp: false,
      skills: false,
      instructions: false,
      workspace: false,
      planMode: false,
      concurrentSend: false,
      cancelQueuedMessage: false,
      stopTask: false,
      modes: false,
    },
    execute: (ctx) => runHttpAgent(opts, ctx),
    resolveAuth,
    sessionCodec: httpAgentSessionCodec,
  };
}
