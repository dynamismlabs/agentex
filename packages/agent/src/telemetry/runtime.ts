import { createHmac, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderRuntimeContext } from "../types.js";
import { buildEnv, ensurePathInEnv } from "../utils/env.js";
import { translateEndpoint } from "../utils/endpoint.js";
import { findBinary } from "../utils/binary.js";

export type NativeTelemetryProvider = "claude" | "codex";
const keySalt = randomBytes(32);

export async function telemetryRuntime(provider: NativeTelemetryProvider, ctx: ProviderRuntimeContext) {
  const config = structuredClone(ctx.config ?? {});
  const cwd = resolve(ctx.cwd ?? process.cwd());
  const env = buildEnv(ctx.env); ensurePathInEnv(env);
  const homeKey = provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const endpoint = translateEndpoint(provider, config.endpoint);
  Object.assign(env, endpoint.env); for (const key of endpoint.unset) delete env[key];
  const home = resolve(cwd, env[homeKey] ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), provider === "codex" ? ".codex" : ".claude"));
  const authPaths = provider === "codex" ? [join(home, "auth.json")]
    : [join(home, ".credentials.json"), join(env.HOME ?? env.USERPROFILE ?? homedir(), ".claude.json")];
  // Detect native file-backed auth changes without reading or retaining tokens.
  let binary;
  try { binary = await findBinary(provider, config.command); } catch { /* Reported by the operation, without native startup. */ }
  const fingerprint = async (path: string) => {
    try { const info = await stat(path); return [path, info.ino, info.size, info.mtimeMs, info.ctimeMs]; }
    catch { return [path, null]; }
  };
  const [authFiles, runtimeFiles] = await Promise.all([
    Promise.all(authPaths.map(fingerprint)),
    Promise.all(binary ? [binary.bin, ...binary.prefixArgs].map((path) => fingerprint(resolve(path))) : []),
  ]);
  const key = createHmac("sha256", keySalt).update(canonical({ provider, cwd, env, config, binary, authFiles, runtimeFiles })).digest("hex");
  return { provider, config, cwd, env, binary, endpointArgs: endpoint.args, key };
}

/** Environment/config values never enter a map key or a diagnostic verbatim. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export const claudeTelemetryArgs = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

export type TelemetryRuntime = Awaited<ReturnType<typeof telemetryRuntime>>;
