import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../types.js";
import { findBinary } from "../utils/binary.js";
import { runChildProcess } from "../utils/process.js";
import { NativeTelemetryRpc } from "./native-rpc.js";
import { codexMcpVersionSupported } from "../providers/codex/mcp.js";
import { claudeContextUsage } from "../providers/claude/parse.js";
import { readRateLimitsFromRpc } from "./rate-limit-read.js";
import { claudeTelemetryArgs, telemetryRuntime, type NativeTelemetryProvider, type TelemetryRuntime } from "./runtime.js";
import { TelemetryFlights } from "./single-flight.js";

const probes = new TelemetryFlights<ProviderRuntimeReport>();
const capability = (supported: boolean, reason?: string) => ({ supported, status: supported ? "supported" as const : "degraded" as const, ...(reason ? { reason } : {}) });

/** Native telemetry diagnostics never determine binary/session availability. No completed-report cache. */
export async function probeNativeTelemetry(provider: NativeTelemetryProvider, ctx: ProviderRuntimeContext = {}): Promise<ProviderRuntimeReport> {
  try {
    const runtime = await telemetryRuntime(provider, ctx);
    return await probes.run(runtime.key, (signal) => probeRuntime(runtime, signal), { timeoutMs: 60_000 });
  } catch {
    // Even a failed probe setup/deadline must not turn an installed harness into
    // a missing/degraded binary and disable unrelated consuming-app features.
    try { return baseReport(provider, (await findBinary(provider, ctx.config?.command)).bin); }
    catch { return missingReport(); }
  }
}

async function probeRuntime(runtime: TelemetryRuntime, signal: AbortSignal): Promise<ProviderRuntimeReport> {
  const binary = runtime.binary;
  if (!binary) return missingReport();
  const report = baseReport(runtime.provider, binary.bin);
  // Version and MCP compatibility are independent of the telemetry handshake.
  const version = await runChildProcess({ runId: `${runtime.provider}-telemetry-version`, command: binary.bin,
    args: [...binary.prefixArgs, "--version"], cwd: runtime.cwd, env: runtime.env, timeoutSec: 5, graceSec: 1, signal });
  report.binary.version = version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (runtime.provider === "codex") {
    const mcpSupported = codexMcpVersionSupported(report.binary.version);
    report.capabilities.mcp = report.capabilities.strictMcpIsolation = capability(mcpSupported,
      mcpSupported ? undefined : "Host-supplied MCP configuration/isolation requires Codex CLI 0.160.0 or newer");
    const dir = await mkdtemp(join(tmpdir(), "agentex-codex-telemetry-"));
    let contextSupported = false;
    try {
      const schema = await runChildProcess({ runId: "codex-telemetry-schema", command: binary.bin,
        args: [...binary.prefixArgs, "app-server", "generate-ts", "--out", dir], cwd: runtime.cwd, env: runtime.env, timeoutSec: 5, graceSec: 1, signal });
      if (schema.exitCode === 0) {
        const source = await readFile(join(dir, "v2", "ThreadTokenUsage.ts"), "utf8");
        contextSupported = /last:\s*TokenUsageBreakdown/.test(source) && source.includes("modelContextWindow");
      }
    } catch { /* An older runtime can establish support by emitting a valid notification. */ }
    finally { await rm(dir, { recursive: true, force: true }); }
    report.capabilities.contextUsage = capability(contextSupported, contextSupported ? undefined : "Could not verify current-context schema; support is learned from valid notifications");
    report.capabilities.contextUsageRefresh = capability(false, "Codex reports current context by notification/transcript, without a context read RPC");
  }

  let rpc: NativeTelemetryRpc | undefined;
  try {
    rpc = new NativeTelemetryRpc(binary.bin, [...binary.prefixArgs, ...(runtime.provider === "codex"
      ? [...runtime.endpointArgs, "app-server"] : claudeTelemetryArgs)], runtime.cwd, runtime.env, runtime.provider, signal);
    await rpc.request("initialize", runtime.provider === "codex"
      ? { clientInfo: { name: "agentex-telemetry-probe", version: "1" }, capabilities: { experimentalApi: true } } : {}, 5000);
    if (runtime.provider === "claude") {
      const context = await rpc.request("get_context_usage", { detail: "summary" }).catch(() => null);
      const supported = Boolean(claudeContextUsage(context, new Date().toISOString()));
      report.capabilities.contextUsage = report.capabilities.contextUsageRefresh = capability(supported,
        supported ? undefined : "Selected CLI did not provide get_context_usage metrics");
    }
    if (runtime.config.endpoint) {
      report.capabilities.rateLimits = report.capabilities.rateLimitsRefresh = capability(false, "Custom endpoints do not expose the harness account's plan capacity");
    } else {
      const rates = await readRateLimitsFromRpc(runtime.provider, rpc, 5000).catch(() => null);
      const supported = rates?.support === "supported";
      report.capabilities.rateLimits = report.capabilities.rateLimitsRefresh = capability(supported,
        supported ? undefined : rates?.reason ?? "Account rate-limit read failed or timed out");
    }
  } catch { /* Only telemetry capabilities retain their degraded diagnostics. */ }
  finally { await rpc?.close(); }
  return report;
}

function baseReport(provider: NativeTelemetryProvider, command: string): ProviderRuntimeReport {
  const unavailable = capability(false, "Native telemetry handshake failed or timed out");
  return { binary: { status: "supported", command, version: null, protocolProfile: `${provider}-native-telemetry` }, capabilities: {
    contextUsage: unavailable, contextUsageRefresh: unavailable, rateLimits: unavailable, rateLimitsRefresh: unavailable,
  } };
}
function missingReport(): ProviderRuntimeReport {
  return { binary: { status: "missing", command: null, version: null, protocolProfile: null }, capabilities: {} };
}
