import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { acquireOpenCodeRuntime } from "./runtime.js";
import { fetchV2Agents, rec, serverApiVersion } from "./v2.js";

function capability(
  supported: boolean,
  reason?: string,
): { supported: boolean; status: "supported" | "upgrade_required"; reason?: string } {
  return {
    supported,
    status: supported ? "supported" : "upgrade_required",
    ...(reason ? { reason } : {}),
  };
}

export async function probeOpenCodeCapabilities(
  ctx: ProviderRuntimeContext = {},
): Promise<ProviderRuntimeReport> {
  let resolved;
  try {
    resolved = await findBinary("opencode", ctx.config?.command);
  } catch (error) {
    return {
      binary: {
        status: "missing",
        command: null,
        version: null,
        protocolProfile: null,
        reason: error instanceof Error ? error.message : String(error),
      },
      capabilities: {},
    };
  }

  const env = buildEnv(ctx.env);
  ensurePathInEnv(env);
  let version: string | null = null;
  try {
    const result = await runChildProcess({
      runId: "opencode-version-probe",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "--version"],
      cwd: ctx.cwd ?? process.cwd(),
      env,
      timeoutSec: 5,
    });
    version = (result.stdout || result.stderr).match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
  } catch {
    // The authenticated API probe below remains authoritative.
  }

  try {
    const runtime = await acquireOpenCodeRuntime(ctx);
    try {
      const apiVersion = serverApiVersion(runtime.server);
      const isV2 = apiVersion === 2;
      const doc = await runtime.server.client.json<Record<string, unknown>>(isV2 ? "/openapi.json" : "/doc");
      const agents = isV2
        ? await fetchV2Agents(runtime.server.client).catch(() => [])
        : await runtime.server.client
            .json<unknown>("/agent")
            .then((raw) => (Array.isArray(raw) ? raw : []))
            .catch(() => []);
      const paths = rec(doc["paths"]);
      const has = (path: string, method: string) => Boolean(rec(paths[path])[method]);
      const supportsDisconnect = isV2
        ? has("/api/credential/{credentialID}", "delete")
        : has("/auth/{providerID}", "delete");
      const capabilities: ProviderRuntimeReport["capabilities"] = {
        contextUsage: { supported: false, status: "degraded", reason: "Selected opencode transport exposes no verified current-context or account-capacity observation" },
        contextUsageRefresh: { supported: false, status: "degraded", reason: "Selected opencode transport exposes no verified current-context or account-capacity observation" },
        rateLimits: { supported: false, status: "degraded", reason: "Selected opencode transport exposes no verified current-context or account-capacity observation" },
        rateLimitsRefresh: { supported: false, status: "degraded", reason: "Selected opencode transport exposes no verified current-context or account-capacity observation" },
        sessions: capability(
          isV2
            ? has("/api/session", "post") && has("/api/session/{sessionID}/prompt", "post")
            : has("/session", "post") && has("/session/{sessionID}/message", "post"),
        ),
        resume: capability(has(isV2 ? "/api/session/{sessionID}" : "/session/{sessionID}", "get")),
        modelDiscovery: capability(has(isV2 ? "/api/model" : "/provider", "get")),
        modelVariants: capability(has(isV2 ? "/api/model" : "/provider", "get")),
        permissionRequests: capability(
          isV2
            ? has("/api/session/{sessionID}/permission", "get") && has("/api/session/{sessionID}/permission/{requestID}/reply", "post")
            : has("/permission", "get") && has("/permission/{requestID}/reply", "post"),
        ),
        questionRequests: capability(
          isV2
            ? has("/api/session/{sessionID}/form", "get") && has("/api/session/{sessionID}/form/{formID}/reply", "post")
            : has("/question", "get") && has("/question/{requestID}/reply", "post"),
        ),
        upstreamProviderDisconnect: capability(supportsDisconnect),
        durableHistory: capability(has(isV2 ? "/api/session/{sessionID}/message" : "/session/{sessionID}/message", "get")),
        savedHistory: capability(
          isV2
            ? has("/api/session", "get") && has("/api/session/{sessionID}/message", "get")
            : (has("/experimental/session", "get") || has("/session", "get")) && has("/session/{sessionID}/message", "get"),
        ),
        planMode: capability(agents.some((value) => {
          const agent = rec(value);
          return agent["name"] === "plan" || agent["id"] === "plan";
        })),
        modes: capability(agents.length > 0),
        sessionModelChange: capability(isV2 ? has("/api/session/{sessionID}/model", "post") : true),
        sessionVariantChange: capability(isV2 ? has("/api/session/{sessionID}/model", "post") : true),
        sessionModeChange: capability(
          isV2 ? agents.length > 0 && has("/api/session/{sessionID}/agent", "post") : agents.length > 0,
        ),
      };
      const required = ["sessions", "modelDiscovery", "permissionRequests", "questionRequests"] as const;
      const degraded = required.some((key) => !capabilities[key]?.supported);
      return {
        binary: {
          status: degraded ? "degraded" : "supported",
          command: resolved.bin,
          version: version ?? runtime.server.serverVersion ?? null,
          protocolProfile: isV2
            ? (supportsDisconnect ? "opencode-server-auth-v2" : "opencode-server-v2")
            : (supportsDisconnect ? "opencode-server-auth-v1" : "opencode-server-v1"),
          ...(degraded ? { reason: "The OpenCode server schema is missing a required endpoint" } : {}),
        },
        capabilities,
      };
    } finally {
      runtime.server.release();
    }
  } catch (error) {
    return {
      binary: {
        status: "degraded",
        command: resolved.bin,
        version,
        protocolProfile: null,
        reason: error instanceof Error ? error.message : String(error),
      },
      capabilities: {},
    };
  }
}
