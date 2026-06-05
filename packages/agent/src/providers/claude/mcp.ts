import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig, ProviderConfig } from "../../types.js";

/**
 * Map agentex `McpServerConfig[]` into Claude's `--mcp-config` JSON shape:
 * `{ "mcpServers": { "<name>": { … } } }`.
 *
 * stdio servers (the default arm) keep `command`/`args`/`env`; http/sse servers
 * carry `url` (+ optional `headers`).
 */
export function buildMcpConfigJson(servers: McpServerConfig[]): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if ("url" in s) {
      mcpServers[s.name] = {
        type: s.type,
        url: s.url,
        ...(s.headers ? { headers: s.headers } : {}),
      };
    } else {
      mcpServers[s.name] = {
        type: "stdio",
        command: s.command,
        ...(s.args ? { args: s.args } : {}),
        ...(s.env ? { env: s.env } : {}),
      };
    }
  }
  return { mcpServers };
}

/**
 * Stage the MCP config as a JSON file (mode 0600) in a fresh `agentex-mcp-*`
 * temp dir and return the file path. HTTP server `headers` can carry bearer
 * tokens, so the config never goes through argv — argv is world-readable via
 * `ps`. Clean up with {@link cleanupMcpConfig} when the run/session ends.
 */
export async function stageMcpConfig(servers: McpServerConfig[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-mcp-"));
  const file = path.join(dir, "mcp-config.json");
  await fs.writeFile(file, JSON.stringify(buildMcpConfigJson(servers), null, 2), {
    mode: 0o600,
  });
  return file;
}

/** Remove a staged MCP config (and its temp dir). Idempotent; null-safe. */
export async function cleanupMcpConfig(filePath: string | null): Promise<void> {
  if (!filePath) return;
  try {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/**
 * The argv tail for Claude's MCP + tool-filtering + partial-message features.
 * Shared by the execute and session arg builders so both stay in lockstep, and
 * exported so tests can snapshot the exact argv. Callers append
 * `config.extraArgs` AFTER this (the host-override invariant).
 */
export function claudeFeatureArgs(config: ProviderConfig, mcpConfigPath: string | null): string[] {
  const args: string[] = [];
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  // Strict works with or without an attached config: strict + no config means
  // "no MCP at all", which embedding hosts use to block ambient .mcp.json /
  // user-scope servers from leaking into a product-controlled session.
  if (config.strictMcpConfig) args.push("--strict-mcp-config");
  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push("--allowed-tools", config.allowedTools.join(","));
  }
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", config.disallowedTools.join(","));
  }
  if (config.includePartialMessages) args.push("--include-partial-messages");
  return args;
}
