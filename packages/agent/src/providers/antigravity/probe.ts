import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { listAntigravityModels } from "./discovery.js";
import { AGY_SIGN_IN_MESSAGE, findAgyBinary } from "./runtime.js";

/** Flags the adapter relies on. All shipped together in Antigravity CLI 1.1.15. */
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--conversation", "--mode", "--model"];

export async function probeAntigravityCapabilities(
  ctx: ProviderRuntimeContext = {},
): Promise<ProviderRuntimeReport> {
  let resolved;
  try {
    resolved = await findAgyBinary(ctx);
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
  const cwd = ctx.cwd ?? process.cwd();
  const run = (runId: string, args: string[], timeoutSec: number) => runChildProcess({
    runId,
    command: resolved.bin,
    args: [...resolved.prefixArgs, ...args],
    cwd,
    env,
    timeoutSec,
  }).catch(() => null);

  const [versionRun, helpRun, models] = await Promise.all([
    run("antigravity-version-probe", ["--version"], 5),
    run("antigravity-protocol-probe", ["--help"], 10),
    listAntigravityModels(ctx).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
  ]);
  const version = versionRun
    ? (`${versionRun.stdout}\n${versionRun.stderr}`).match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null
    : null;
  const help = helpRun ? `${helpRun.stdout}\n${helpRun.stderr}` : "";
  const missingFlags = REQUIRED_FLAGS.filter((flag) => !help.includes(flag));
  const protocolSupported = help.length > 0 && missingFlags.length === 0 && /stream-json/.test(help);
  const modelError = models instanceof Error ? models : null;
  const modelDiscovery = Array.isArray(models) && models.length > 0;
  const signedOut = modelError?.message === AGY_SIGN_IN_MESSAGE;

  const supported = (value: boolean, reason?: string) => ({
    supported: value,
    status: value ? "supported" as const : "upgrade_required" as const,
    ...(!value && reason ? { reason } : {}),
  });
  return {
    binary: {
      status: protocolSupported ? "supported" : "upgrade_required",
      command: resolved.bin,
      version,
      protocolProfile: protocolSupported ? "agy-stream-json-v1" : null,
      ...(!protocolSupported
        ? { reason: `Update Antigravity CLI (\`agy update\`): missing ${missingFlags.join(", ") || "stream-json support"}` }
        : {}),
    },
    capabilities: {
      contextUsage: { supported: false, status: "degraded", reason: "Selected antigravity transport has no verified context or provider-capacity source" },
      contextUsageRefresh: { supported: false, status: "degraded", reason: "Selected antigravity transport has no verified context or provider-capacity source" },
      rateLimits: { supported: false, status: "degraded", reason: "Selected antigravity transport has no verified context or provider-capacity source" },
      rateLimitsRefresh: { supported: false, status: "degraded", reason: "Selected antigravity transport has no verified context or provider-capacity source" },
      sessions: supported(protocolSupported, "Antigravity stream-json input is unavailable"),
      resume: supported(protocolSupported, "Antigravity --conversation resume is unavailable"),
      modelDiscovery: modelDiscovery
        ? supported(true)
        : {
          supported: false,
          // Not signed in is a setup step, not an outdated CLI.
          status: signedOut ? "missing" as const : "upgrade_required" as const,
          reason: signedOut ? AGY_SIGN_IN_MESSAGE : modelError?.message ?? "Antigravity CLI did not list any models",
        },
      planMode: supported(protocolSupported),
      modes: supported(protocolSupported),
      sessionModelChange: supported(false),
      sessionVariantChange: supported(false),
      sessionEffortChange: supported(false),
      sessionModeChange: supported(false),
    },
  };
}
