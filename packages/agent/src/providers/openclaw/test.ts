import type { EnvironmentTestContext, EnvironmentTestResult } from "../../types.js";

export async function testOpenclawEnvironment(
  ctx: EnvironmentTestContext,
): Promise<EnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const gatewayUrl = typeof config["command"] === "string" && config["command"].trim()
    ? config["command"].trim()
    : "http://localhost:3001";

  try {
    const healthUrl = gatewayUrl.replace(/\/$/, "") + "/health";
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      return {
        providerType: ctx.providerType,
        status: "pass",
        checks: [{
          code: "openclaw_gateway_reachable",
          level: "info",
          message: `OpenClaw gateway is reachable at ${gatewayUrl}`,
        }],
        testedAt: new Date().toISOString(),
      };
    }

    return {
      providerType: ctx.providerType,
      status: "warn",
      checks: [{
        code: "openclaw_gateway_unhealthy",
        level: "warn",
        message: `OpenClaw gateway returned status ${response.status}`,
        hint: `Check that the OpenClaw gateway at ${gatewayUrl} is running and healthy.`,
      }],
      testedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      providerType: ctx.providerType,
      status: "fail",
      checks: [{
        code: "openclaw_gateway_unreachable",
        level: "error",
        message: `Cannot reach OpenClaw gateway at ${gatewayUrl}`,
        detail: err instanceof Error ? err.message : String(err),
        hint: `Ensure the OpenClaw gateway is running at ${gatewayUrl}.`,
      }],
      testedAt: new Date().toISOString(),
    };
  }
}
