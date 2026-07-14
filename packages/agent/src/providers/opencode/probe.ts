import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../../types.js";
import { findBinary } from "../../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { acquireOpenCodeRuntime } from "./runtime.js";

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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
      const doc = await runtime.server.client.json<Record<string, unknown>>("/doc");
      const agents = await runtime.server.client.json<unknown[]>("/agent").catch(() => []);
      const paths = rec(doc["paths"]);
      const has = (path: string, method: string) => Boolean(rec(paths[path])[method]);
      const supportsDisconnect = has("/auth/{providerID}", "delete");
      const capabilities: ProviderRuntimeReport["capabilities"] = {
        sessions: capability(has("/session", "post") && has("/session/{sessionID}/message", "post")),
        resume: capability(has("/session/{sessionID}", "get")),
        modelDiscovery: capability(has("/provider", "get")),
        modelVariants: capability(has("/provider", "get")),
        permissionRequests: capability(has("/permission", "get") && has("/permission/{requestID}/reply", "post")),
        questionRequests: capability(has("/question", "get") && has("/question/{requestID}/reply", "post")),
        upstreamProviderDisconnect: capability(supportsDisconnect),
        durableHistory: capability(has("/session/{sessionID}/message", "get")),
        savedHistory: capability(
          (has("/experimental/session", "get") || has("/session", "get"))
          && has("/session/{sessionID}/message", "get"),
        ),
        planMode: capability(agents.some((value) => {
          const agent = rec(value);
          return agent["name"] === "plan" || agent["id"] === "plan";
        })),
        modes: capability(agents.length > 0),
        sessionModelChange: capability(true),
        sessionVariantChange: capability(true),
        sessionModeChange: capability(agents.length > 0),
      };
      const required = ["sessions", "modelDiscovery", "permissionRequests", "questionRequests"] as const;
      const degraded = required.some((key) => !capabilities[key]?.supported);
      return {
        binary: {
          status: degraded ? "degraded" : "supported",
          command: resolved.bin,
          version,
          protocolProfile: supportsDisconnect ? "opencode-server-auth-v1" : "opencode-server-v1",
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
