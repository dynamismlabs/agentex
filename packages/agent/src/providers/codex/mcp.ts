import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { promisify } from "node:util";
import type { ProviderConfig } from "../../types.js";
import type { ResolvedBinary } from "../../utils/binary.js";

const run = promisify(execFile);
type NativeServer = { name: string; enabled: boolean; transport: { type: "stdio" | "streamable_http" } };

/** Config flags must precede app-server. Keeping them separate also lets the
 * read-only discovery process use the exact same config/profile/cwd overrides. */
export function splitCodexExtraArgs(args: string[] = []): { configArgs: string[]; runtimeArgs: string[] } {
  const configArgs: string[] = [], runtimeArgs: string[] = [];
  const flags = ["-c", "--config", "-p", "--profile", "-C", "--cd", "--enable", "--disable"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error("Codex config flag is missing its value");
      configArgs.push(arg, value);
    } else if (flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)) || /^-[cpC].+/.test(arg)) {
      configArgs.push(arg);
    } else runtimeArgs.push(arg);
  }
  return { configArgs, runtimeArgs };
}

export function codexMcpVersionSupported(version: string | null): boolean {
  const match = version?.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 160));
}

/** TOML inline tables, unlike JSON, use '=' and preserve literal keys containing dots. */
export function codexMcpToml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(codexMcpToml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${codexMcpToml(item)}`).join(", ")} }`;
  throw new Error("Unsupported Codex MCP config value");
}

// Codex's stdio env_vars cannot rename a variable per server. A tiny transport
// launcher therefore overlays each server's own env, sourced from a unique
// child-only variable. This avoids argv secrets and conflicts between servers
// that use the same env key. No temp files or global configuration are needed.
const STDIO_LAUNCHER = `const {spawn}=require('node:child_process');
const key=process.argv[1];
const config=JSON.parse(process.env[key]);
const env={...process.env}; for(const name of Object.keys(env)) if(name.startsWith('AGENTEX_CODEX_MCP_')) delete env[name]; Object.assign(env,config.env);
const child=spawn(config.command,config.args,{env,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('MCP server failed to start\\n');process.exit(1)});
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{child.kill(signal);setTimeout(()=>child.kill('SIGKILL'),1000).unref()});`;

async function nativeServers(binary: ResolvedBinary, configArgs: string[], cwd: string, env: Record<string, string>): Promise<NativeServer[]> {
  try {
    const { stdout } = await run(binary.bin, [...binary.prefixArgs, ...configArgs, "mcp", "list", "--json"], {
      cwd, env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item.name !== "string" || typeof item.enabled !== "boolean"
      || !["stdio", "streamable_http"].includes(item.transport?.type))) throw new Error("Invalid inventory");
    return parsed;
  } catch {
    // Native output can contain ambient credentials. Never forward it or an
    // execFile error (which embeds stdout/stderr) to callbacks or callers.
    throw new Error("Could not verify Codex MCP configuration. A working Codex CLI 0.160.0 or newer is required; no session was started.");
  }
}

/** Build secure invocation-local MCP overrides, failing closed when strict
 * isolation cannot be proved. Auth/history stay in the original CODEX_HOME.
 * Without any MCP option, existing ambient Codex behavior is unchanged. */
export async function prepareCodexMcp(
  config: ProviderConfig, binary: ResolvedBinary, configArgs: string[], cwd: string, childEnv: Record<string, string>,
): Promise<{ args: string[]; env: Record<string, string> }> {
  if (config.mcpServers === undefined && !config.strictMcpConfig) return { args: [], env: {} };
  // `mcp list` does not inherit the runtime's --cd/--worktree options. Letting
  // exec select a different project after discovery would defeat isolation.
  if (config.extraArgs?.some((arg) => arg.startsWith("-C") || arg === "--cd" || arg.startsWith("--cd=")
    || arg === "--worktree" || arg.startsWith("--worktree="))) {
    throw new Error("Codex MCP configuration requires the context cwd and ProviderConfig.workspace; --cd/--worktree extraArgs cannot be verified safely");
  }
  const servers = config.mcpServers ?? [];
  const strict = config.strictMcpConfig ?? true;
  const names = new Set<string>();
  for (const server of servers) {
    if (!server.name || names.has(server.name) || server.name === "codex_apps") throw new Error("Codex MCP server names must be unique, nonempty, and must not be codex_apps");
    names.add(server.name);
    if (server.type === "sse") throw new Error("Codex MCP supports stdio and streamable HTTP, not legacy SSE");
  }
  let version: string;
  try {
    version = (await run(binary.bin, [...binary.prefixArgs, "--version"], { cwd, env: childEnv, timeout: 5000, killSignal: "SIGKILL" })).stdout;
  } catch { throw new Error("Could not verify Codex MCP runtime version"); }
  if (!codexMcpVersionSupported(version)) throw new Error("Codex MCP configuration requires Codex CLI 0.160.0 or newer");

  const ambient = await nativeServers(binary, configArgs, cwd, childEnv);
  // Merged native tables cannot safely replace a same-name server's transport,
  // credentials or per-tool policy. Fail explicitly instead of inheriting any
  // of those fields into a host-owned server.
  if (ambient.some((server) => names.has(server.name))) throw new Error("A host-supplied Codex MCP server conflicts with an ambient server name. Choose a distinct host server name.");
  const entries = new Map<string, Record<string, unknown>>();
  if (strict) for (const server of ambient) {
    // A disabled registration vetoes a same-name plugin registration in 0.160.
    // Supply a valid inert transport for plugin-only entries as well.
    entries.set(server.name, { enabled: false, ...(server.transport.type === "stdio" ? { command: process.execPath } : { url: "http://127.0.0.1:9/" }) });
  }
  const env: Record<string, string> = {};
  const variable = (value: string) => {
    let name: string;
    do { name = `AGENTEX_CODEX_MCP_${randomUUID().replaceAll("-", "_")}`; } while (name in childEnv || name in env);
    env[name] = value;
    return name;
  };
  for (const server of servers) {
    const native: Record<string, unknown> = { enabled: true, default_tools_approval_mode: "approve" };
    if ("url" in server) {
      let url: URL;
      try { url = new URL(server.url); }
      catch { throw new Error("Codex MCP requires a valid HTTP(S) URL; supply auth in headers"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Codex MCP requires an HTTP(S) URL without embedded credentials; supply auth in headers");
      native.url = server.url;
      const headers: Record<string, string> = Object.create(null);
      try {
        for (const [name, value] of Object.entries(server.headers ?? {})) {
          validateHeaderName(name); validateHeaderValue(name, value);
          if (name.toLowerCase() === "authorization" && /^Bearer \S+$/i.test(value)) native.bearer_token_env_var = variable(value.slice(7));
          else headers[name] = variable(value);
        }
      } catch { throw new Error("Invalid Codex MCP HTTP header"); }
      if (Object.keys(headers).length) native.env_http_headers = headers;
    } else if (server.env && Object.keys(server.env).length) {
      const key = variable(JSON.stringify({ command: server.command, args: server.args ?? [], env: server.env }));
      native.command = process.execPath;
      native.args = ["-e", STDIO_LAUNCHER, key];
      native.env_vars = [key];
    } else {
      native.command = server.command;
      native.args = server.args ?? [];
    }
    entries.set(server.name, native);
  }
  const args = ["-c", `mcp_servers=${codexMcpToml(Object.fromEntries(entries))}`];
  const effective = await nativeServers(binary, [...configArgs, ...args], cwd, { ...childEnv, ...env });
  const enabled = new Set(effective.filter((server) => server.enabled).map((server) => server.name));
  if (servers.some((server) => !enabled.has(server.name)) || (strict && [...enabled].some((name) => !names.has(name)))) {
    throw new Error("Codex MCP configuration did not establish the requested server set; no session was started");
  }
  return { args, env };
}
