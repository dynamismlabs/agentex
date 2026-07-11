import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../../types.js";
import { buildEnv, ensurePathInEnv } from "../../utils/env.js";
import { runChildProcess } from "../../utils/process.js";
import { listCursorModels, listCursorModes } from "./discovery.js";
import { findCursorBinary } from "./runtime.js";

export async function probeCursorCapabilities(
  ctx: ProviderRuntimeContext = {},
): Promise<ProviderRuntimeReport> {
  let resolved;
  try {
    resolved = await findCursorBinary(ctx);
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
      runId: "cursor-version-probe",
      command: resolved.bin,
      args: [...resolved.prefixArgs, "--version"],
      cwd: ctx.cwd ?? process.cwd(),
      env,
      timeoutSec: 5,
    });
    version = (result.stdout || result.stderr).match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
  } catch {
    // Feature probes remain authoritative.
  }
  const [models, modes] = await Promise.all([
    listCursorModels(ctx).catch(() => []),
    listCursorModes(ctx).catch(() => []),
  ]);
  const help = await runChildProcess({
    runId: "cursor-protocol-probe",
    command: resolved.bin,
    args: [...resolved.prefixArgs, "--help"],
    cwd: ctx.cwd ?? process.cwd(),
    env,
    timeoutSec: 10,
  }).catch(() => null);
  const helpOutput = help ? `${help.stdout}\n${help.stderr}` : "";
  const protocolSupported = help?.exitCode === 0
    && /(?:^|\s)(?:-p(?:,|\s))?.*--print\b/m.test(helpOutput)
    && /--output-format\b/.test(helpOutput)
    && /\bstream-json\b/i.test(helpOutput)
    && /--resume\b/.test(helpOutput);
  const modelDiscovery = models.length > 0;
  const modeIds = new Set(modes.map((mode) => mode.id));
  const supported = (value: boolean, reason?: string) => ({
    supported: value,
    status: value ? "supported" as const : "upgrade_required" as const,
    ...(!value && reason ? { reason } : {}),
  });
  return {
    binary: {
      status: modelDiscovery && protocolSupported ? "supported" : "upgrade_required",
      command: resolved.bin,
      version,
      protocolProfile: protocolSupported ? "cursor-stream-json-system-init-v1" : null,
      ...(!modelDiscovery
        ? { reason: "Upgrade Cursor CLI to a version with model listing" }
        : !protocolSupported
          ? { reason: "Cursor CLI does not advertise print, stream output, and resume support" }
          : {}),
    },
    capabilities: {
      sessions: supported(Boolean(protocolSupported), "Cursor stream-json session flags are unavailable"),
      resume: supported(Boolean(protocolSupported), "Cursor resume support is unavailable"),
      modelDiscovery: supported(modelDiscovery, "Cursor model listing is unavailable"),
      planMode: supported(modeIds.has("plan")),
      modes: supported(modes.length > 0),
      sessionModelChange: supported(false),
      sessionVariantChange: supported(false),
      sessionEffortChange: supported(false),
      sessionModeChange: supported(false),
    },
  };
}
