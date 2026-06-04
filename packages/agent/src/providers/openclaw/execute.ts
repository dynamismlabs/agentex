import type { ExecutionContext, ExecutionResult } from "../../types.js";
import { runHttpAgent } from "../_shared/http-agent.js";

/**
 * OpenClaw is a remote HTTP-gateway agent — its behavior is the canonical
 * `httpAgent` pattern (URL resolution, sessionKey round-trip, 401/403 →
 * auth_required, AbortController timeout), so it's a thin call into the shared base.
 */
export function executeOpenclawProvider(ctx: ExecutionContext): Promise<ExecutionResult> {
  return runHttpAgent(
    {
      providerType: "openclaw",
      defaultBaseUrl: "http://localhost:3001",
      runPath: "/api/agent/run",
      loginCommand: "openclaw login",
    },
    ctx,
  );
}
