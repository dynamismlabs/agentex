import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderRuntimeContext, ProviderRuntimeReport } from "../types.js";
import { findBinary } from "../utils/binary.js";
import { buildEnv, ensurePathInEnv } from "../utils/env.js";
import { translateEndpoint } from "../utils/endpoint.js";
import { record, textValue } from "../utils/jsonl-lines.js";
import { runChildProcess } from "../utils/process.js";
import { NativeTelemetryRpc } from "./native-rpc.js";
import { codexRateLimits } from "../providers/codex/transcript-normalize.js";
import { codexMcpVersionSupported } from "../providers/codex/mcp.js";
import { claudeContextUsage, claudeUsageRateLimits } from "../providers/claude/parse.js";

/** Probes use documented harness controls, never inference prompts or credential endpoints. */
export async function probeNativeTelemetry(provider: "codex" | "claude", ctx: ProviderRuntimeContext = {}): Promise<ProviderRuntimeReport> {
  let binary;
  try { binary = await findBinary(provider, ctx.config?.command); } catch {
    return { binary: { status: "missing", command: null, version: null, protocolProfile: null }, capabilities: {} };
  }
  const env = buildEnv(ctx.env); ensurePathInEnv(env);
  const endpoint = translateEndpoint(provider, ctx.config?.endpoint);
  Object.assign(env, endpoint.env); for (const key of endpoint.unset) delete env[key];
  const args = provider === "codex" ? ["app-server", ...endpoint.args]
    : ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  const rpc = new NativeTelemetryRpc(binary.bin, [...binary.prefixArgs, ...args], ctx.cwd ?? process.cwd(), env, provider);
  const report: ProviderRuntimeReport = {
    binary: { status: "supported", command: binary.bin, version: null, protocolProfile: `${provider}-native-telemetry` }, capabilities: {},
  };
  const capability = (supported: boolean, reason?: string) => ({ supported, status: supported ? "supported" as const : "degraded" as const, ...(reason ? { reason } : {}) });
  try {
    if (provider === "claude") {
      await rpc.request("initialize", {}, 5000);
      const version = await rpc.request("get_binary_version", {}, 5000).catch(() => ({}));
      report.binary.version = textValue(record(version)?.version) ?? null;
      const context = await rpc.request("get_context_usage", { detail: "summary" }).catch(() => null);
      const contextSupported = Boolean(claudeContextUsage(context, new Date().toISOString()));
      report.capabilities.contextUsage = report.capabilities.contextUsageRefresh = capability(contextSupported, contextSupported ? undefined : "Selected CLI did not provide get_context_usage metrics");
      const rates = await rpc.request("get_usage", { skip_behaviors: true }).catch(() => null);
      const ratesSupported = Boolean(claudeUsageRateLimits(rates, new Date().toISOString()));
      report.capabilities.rateLimits = report.capabilities.rateLimitsRefresh = capability(ratesSupported, ratesSupported ? undefined : "Selected runtime/auth context did not provide plan rate limits");
    } else {
      await rpc.request("initialize", { clientInfo: { name: "agentex-telemetry-probe", version: "1" }, capabilities: { experimentalApi: true } }, 5000);
      const version = await runChildProcess({ runId: "codex-telemetry-version", command: binary.bin, args: [...binary.prefixArgs, "--version"], cwd: ctx.cwd ?? process.cwd(), env, timeoutSec: 5 });
      report.binary.version = version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      const mcpSupported = codexMcpVersionSupported(report.binary.version);
      report.capabilities.mcp = report.capabilities.strictMcpIsolation = capability(mcpSupported,
        mcpSupported ? undefined : "Host-supplied MCP configuration/isolation requires Codex CLI 0.160.0 or newer");
      const dir = await mkdtemp(join(tmpdir(), "agentex-codex-telemetry-"));
      let contextSupported = false;
      try {
        const schema = await runChildProcess({ runId: "codex-telemetry-schema", command: binary.bin, args: [...binary.prefixArgs, "app-server", "generate-ts", "--out", dir], cwd: ctx.cwd ?? process.cwd(), env, timeoutSec: 5 });
        if (schema.exitCode === 0) {
          const source = await readFile(join(dir, "v2", "ThreadTokenUsage.ts"), "utf8");
          contextSupported = /last:\s*TokenUsageBreakdown/.test(source) && source.includes("modelContextWindow");
        }
      } catch { /* An older runtime can still establish support by emitting a notification. */ }
      finally { await rm(dir, { recursive: true, force: true }); }
      report.capabilities.contextUsage = capability(contextSupported, contextSupported ? undefined : "Could not verify current-context schema; support is learned from valid notifications");
      report.capabilities.contextUsageRefresh = capability(false, "Codex reports current context by notification/transcript, without a context read RPC");
      const auth = await rpc.request("account/read", { refreshToken: false }, 5000);
      const authType = textValue(record(auth.account)?.type);
      let ratesSupported = false;
      if (!ctx.config?.endpoint && authType && ["chatgpt"].includes(authType)) {
        const response = await rpc.request("account/rateLimits/read").catch(() => null);
        ratesSupported = Boolean(codexRateLimits(response, new Date().toISOString()));
      }
      report.capabilities.rateLimits = report.capabilities.rateLimitsRefresh = capability(ratesSupported, ratesSupported ? undefined : "Account rate limits require a supporting runtime and service-backed auth context");
    }
    return report;
  } catch {
    report.binary.status = "degraded";
    report.binary.reason = "Native telemetry handshake failed or timed out";
    return report;
  } finally { await rpc.close(); }
}
