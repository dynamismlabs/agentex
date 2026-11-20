import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { OpenCodeMcpIsolationError, type McpServerConfig, type ProviderConfig } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { OpenCodeHttpError } from "./client.js";
import { acquireOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { isOpenCodeV2Binary, rec, v2DataRecord } from "./v2.js";

const CONFIG_MCP_PLUGIN = "opencode.config.mcp";
const DISABLE_CONFIG_MCP = `-${CONFIG_MCP_PLUGIN}`;
const ADD_MCP_PATH = "/api/experimental/mcp";

export const OPEN_CODE_MCP_ADD_ROUTE = `${ADD_MCP_PATH}/{server}`;

/** First release qualified for the native config-plugin switch and runtime registration. */
export function supportsOpenCodeMcpIsolation(version: string | null): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\./);
  return Boolean(parts && (Number(parts[1]) > 2 || (Number(parts[1]) === 2 && Number(parts[2]) >= 3)));
}

/** One host server in OpenCode 2's `mcp.servers` shape. */
export function openCodeMcpServerEntry(server: McpServerConfig): Record<string, unknown> {
  if ("url" in server) {
    let url: URL;
    try { url = new URL(server.url); }
    catch { throw new Error(`OpenCode MCP server "${server.name}" needs a valid HTTP(S) URL`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`OpenCode MCP server "${server.name}" needs an HTTP(S) URL`);
    }
    // OpenCode's remote transport tries streamable HTTP, then SSE, so both map here.
    return {
      type: "remote",
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
    };
  }
  return {
    type: "local",
    command: [server.command, ...(server.args ?? [])],
    ...(server.env && Object.keys(server.env).length > 0 ? { environment: { ...server.env } } : {}),
  };
}

function assertServerNames(servers: McpServerConfig[]): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (!server.name || names.has(server.name)) {
      throw new Error("OpenCode MCP server names must be unique and nonempty");
    }
    names.add(server.name);
  }
}

function inlineConfig(env: Record<string, string>): Record<string, unknown> {
  const existing = env["OPENCODE_CONFIG_CONTENT"];
  if (existing === undefined || existing.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(existing); }
  catch { throw new Error("OPENCODE_CONFIG_CONTENT is not valid JSON, so MCP servers cannot be added to it"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT is not a JSON object, so MCP servers cannot be added to it");
  }
  return parsed as Record<string, unknown>;
}

/** Non-strict mode adds the supplied definitions to the caller's inline config. */
export function withOpenCodeMcpConfig(env: Record<string, string>, servers: McpServerConfig[]): Record<string, string> {
  const content = inlineConfig(env);
  const mcp = rec(content["mcp"]);
  const entries = { ...rec(mcp["servers"]), ...Object.fromEntries(servers.map((s) => [s.name, openCodeMcpServerEntry(s)])) };
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, mcp: { ...mcp, servers: entries } }),
  };
}

function withConfigMcpDisabled(env: Record<string, string>): Record<string, string> {
  const content = inlineConfig(env);
  const plugins = content["plugins"] ?? [];
  if (!Array.isArray(plugins)) throw new OpenCodeMcpIsolationError("OpenCode's inline plugins must be an array.");
  return {
    ...env,
    // Managed settings outrank the inline directive. Freeze file-driven changes
    // during the lease so a managed file cannot re-enable the config plugin.
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...content,
      plugins: [...plugins, DISABLE_CONFIG_MCP],
      // Registrations live in the location's runtime. Keep even an idle chat's
      // location alive until the host releases the server lease.
      experimental: { ...rec(content["experimental"]), location_idle_timeout: false },
    }),
  };
}

/** OpenCode processes plugin selectors in document and array order, including wildcards. */
function assertConfigMcpDisabled(payload: unknown): void {
  const entries = Array.isArray(payload) ? payload : rec(payload)["data"];
  if (!Array.isArray(entries)) throw new OpenCodeMcpIsolationError("OpenCode returned an invalid config source list.");
  let inlineDisables = false;
  let enabled = true;
  let idleTimeout: unknown;
  for (const entry of entries) {
    const source = rec(entry);
    if (source["type"] === "directory") continue;
    if (source["type"] !== "document" || !source["info"] || typeof source["info"] !== "object") {
      throw new OpenCodeMcpIsolationError("OpenCode returned an invalid config source.");
    }
    const info = rec(source["info"]);
    const configuredIdle = rec(info["experimental"])["location_idle_timeout"];
    if (configuredIdle !== undefined) idleTimeout = configuredIdle;
    const plugins = info["plugins"] ?? [];
    if (!Array.isArray(plugins)) throw new OpenCodeMcpIsolationError("OpenCode returned invalid plugin selectors.");
    if (source["path"] == null && source["integrationID"] == null && plugins.at(-1) === DISABLE_CONFIG_MCP) {
      inlineDisables = true;
    }
    for (const plugin of plugins) {
      const remove = typeof plugin === "string" && plugin.startsWith("-");
      const selector = typeof plugin === "string" ? (remove ? plugin.slice(1) : plugin) : rec(plugin)["package"];
      if (typeof selector !== "string") throw new OpenCodeMcpIsolationError("OpenCode returned an invalid plugin selector.");
      if (selector === CONFIG_MCP_PLUGIN || selector === "*" ||
          (selector.endsWith(".*") && CONFIG_MCP_PLUGIN.startsWith(selector.slice(0, -1)))) {
        enabled = !remove;
      }
    }
  }
  if (!inlineDisables || enabled) {
    throw new OpenCodeMcpIsolationError(
      "OpenCode's config-driven MCP plugin could not be disabled. Check for managed settings that enable it.",
    );
  }
  if (idleTimeout !== false) {
    throw new OpenCodeMcpIsolationError("OpenCode could not retain the location for the lifetime of its MCP registrations.");
  }
}

/** A native resume can select a different location, whose MCP registry is separate. */
export async function assertOpenCodeMcpSessionFolder(server: OpenCodeServerHandle, id: string, cwd: string): Promise<void> {
  const record = await server.client.json<unknown>(`/api/session/${encodeURIComponent(id)}`).catch((error) => {
    if (error instanceof OpenCodeHttpError && error.status === 404) return null;
    throw error;
  });
  if (record === null) return;
  const folder = rec(v2DataRecord(record)["location"])["directory"];
  if (folder !== await realpath(cwd)) {
    throw new OpenCodeMcpIsolationError("The saved OpenCode session uses a different folder from the verified MCP runtime.");
  }
}

export interface PreparedOpenCodeMcp {
  /** The env to start OpenCode with. */
  env: Record<string, string>;
  /**
   * A server already started with `env`, when isolating needed one. The caller
   * owns it: use it, or release it.
   */
  server: OpenCodeServerHandle | null;
}

/**
 * Apply `config.mcpServers` and `config.strictMcpConfig`. Strict is the default
 * once servers are supplied, as for Codex. Without either option the env is
 * unchanged and OpenCode keeps its own MCP configuration. OpenCode 1 reads a
 * different config shape and its isolation was never verified, so it runs
 * without the host servers and says so on `onNotice`.
 */
export async function prepareOpenCodeMcp(args: {
  config: ProviderConfig;
  binary: ResolvedBinary;
  env: Record<string, string>;
  cwd: string;
  onNotice?: (message: string) => void;
}): Promise<PreparedOpenCodeMcp> {
  const { config, binary, env, cwd } = args;
  if (config.mcpServers === undefined && !config.strictMcpConfig) return { env, server: null };
  const servers = config.mcpServers ?? [];
  assertServerNames(servers);

  if (!(await isOpenCodeV2Binary(binary.bin, binary.prefixArgs))) {
    try {
      args.onNotice?.("agentex: OpenCode MCP configuration needs OpenCode 2, so this chat runs without the host's MCP servers and with OpenCode's own.\n");
    } catch { /* a notice must never stop the run */ }
    return { env, server: null };
  }

  if (config.strictMcpConfig === false) {
    return { env: withOpenCodeMcpConfig(env, servers), server: null };
  }

  // Remove the source of ambient registrations, even if a config reload adds new names.
  // The experimental API's overrides supply the only server definitions for this lease.
  const isolatedEnv = withConfigMcpDisabled(env);
  const entries = servers.map((server) => [server.name, openCodeMcpServerEntry(server)] as const);
  const key = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const isolated = await acquireOpenCodeServer(binary.bin, binary.prefixArgs, isolatedEnv, cwd, key);
  try {
    if (isolated.apiVersion !== 2 || !supportsOpenCodeMcpIsolation(isolated.serverVersion)) {
      throw new OpenCodeMcpIsolationError("Strict MCP isolation requires OpenCode 2.3.0 or newer.");
    }
    assertConfigMcpDisabled(await isolated.client.json<unknown>("/api/config", { signal: AbortSignal.timeout(10_000) }));
    for (const [name, config] of entries) {
      await isolated.client.ok(`${ADD_MCP_PATH}/${encodeURIComponent(name)}`, {
        method: "PUT", body: JSON.stringify({ config }), signal: AbortSignal.timeout(10_000),
      });
    }
    return { env: isolatedEnv, server: isolated };
  } catch (error) {
    isolated.release();
    if (error instanceof OpenCodeMcpIsolationError) throw error;
    throw new OpenCodeMcpIsolationError("Could not verify or register MCP servers on the private OpenCode server.");
  }
}
