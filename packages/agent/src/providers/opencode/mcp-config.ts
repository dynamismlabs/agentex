import { OpenCodeMcpIsolationError, type McpServerConfig, type ProviderConfig } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";
import { acquireOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { isOpenCodeV2Binary, rec, v2DataArray } from "./v2.js";

/**
 * Host-supplied MCP servers reach OpenCode 2 through `OPENCODE_CONFIG_CONTENT`,
 * the config document it loads after the global, directory and project ones,
 * so a host server replaces an ambient one of the same name.
 *
 * OpenCode connects MCP servers when a session starts, not when `opencode
 * serve` boots, and `GET /api/config` lists every config source's servers. So
 * strict isolation reads the ambient names from a booted server and, when there
 * are any, restarts it with each one disabled in the same document. Nothing an
 * ambient entry names is contacted or run. Verified against OpenCode 2.3.0 with
 * a project and a global server: both report `disabled` and receive nothing.
 */

/** OpenCode validates each config document whole, so a disable needs a complete, inert server. */
const DISABLED_SERVER = { type: "remote", url: "http://127.0.0.1:9/", disabled: true } as const;

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

/**
 * The env with `servers` (and `disabled` names as inert disabled entries)
 * merged into `OPENCODE_CONFIG_CONTENT`, keeping anything already there.
 */
export function withOpenCodeMcpConfig(
  env: Record<string, string>,
  servers: McpServerConfig[],
  disabled: string[] = [],
): Record<string, string> {
  let content: Record<string, unknown> = {};
  const existing = env["OPENCODE_CONFIG_CONTENT"];
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); }
    catch { throw new Error("OPENCODE_CONFIG_CONTENT is not valid JSON, so MCP servers cannot be added to it"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT is not a JSON object, so MCP servers cannot be added to it");
    }
    content = parsed as Record<string, unknown>;
  }
  const mcp = rec(content["mcp"]);
  const entries: Record<string, unknown> = { ...rec(mcp["servers"]) };
  for (const name of disabled) entries[name] = { ...DISABLED_SERVER };
  for (const server of servers) entries[server.name] = openCodeMcpServerEntry(server);
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, mcp: { ...mcp, servers: entries } }),
  };
}

/** Every MCP server name across the config sources `GET /api/config` reports. */
export function openCodeConfigServerNames(payload: unknown): Set<string> {
  const names = new Set<string>();
  for (const source of v2DataArray(payload)) {
    const mcp = rec(rec(rec(source)["info"])["mcp"]);
    // OpenCode reports every source in the `servers` shape, migrating older documents.
    const servers = "servers" in mcp ? rec(mcp["servers"]) : mcp;
    for (const name of Object.keys(servers)) names.add(name);
  }
  return names;
}

async function configServerNames(server: OpenCodeServerHandle): Promise<Set<string>> {
  try {
    return openCodeConfigServerNames(await server.client.json<unknown>("/api/config"));
  } catch {
    throw new OpenCodeMcpIsolationError(
      "Could not read OpenCode's MCP configuration to isolate it. OpenCode 2.3.0 or newer is required; no session was started.",
    );
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

  const hostEnv = withOpenCodeMcpConfig(env, servers);
  if (!(config.strictMcpConfig ?? true)) return { env: hostEnv, server: null };

  const host = new Set(servers.map((server) => server.name));
  const first = await acquireOpenCodeServer(binary.bin, binary.prefixArgs, hostEnv, cwd);
  let ambient: string[];
  try {
    ambient = [...await configServerNames(first)].filter((name) => !host.has(name));
  } catch (error) {
    first.release();
    throw error;
  }
  if (ambient.length === 0) return { env: hostEnv, server: first };

  // Releasing the last reference stops this server before any session connected its MCP.
  first.release();
  const isolatedEnv = withOpenCodeMcpConfig(env, servers, ambient);
  const isolated = await acquireOpenCodeServer(binary.bin, binary.prefixArgs, isolatedEnv, cwd);
  try {
    const disabled = new Set(ambient);
    const unexpected = [...await configServerNames(isolated)].filter((name) => !host.has(name) && !disabled.has(name));
    // A config file that gained a server between the two reads: refuse rather than run with it.
    if (unexpected.length > 0) {
      throw new OpenCodeMcpIsolationError(
        "OpenCode's MCP configuration changed while it was being isolated; no session was started.",
      );
    }
    return { env: isolatedEnv, server: isolated };
  } catch (error) {
    isolated.release();
    throw error;
  }
}
