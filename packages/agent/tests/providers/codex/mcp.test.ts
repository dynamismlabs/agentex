import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexMcpVersionSupported, prepareCodexMcp, splitCodexExtraArgs } from "../../../src/providers/codex/mcp.js";
import { createCodexSession } from "../../../src/providers/codex/session.js";
import { executeCodexProvider } from "../../../src/providers/codex/execute.js";
import type { McpServerConfig } from "../../../src/types.js";

const fixture = fileURLToPath(new URL("../../fixtures/mock-codex-mcp-harness.mjs", import.meta.url));
const binary = { bin: process.execPath, prefixArgs: [fixture] };
const server = (name: string, enabled = true, type = "stdio") => ({ name, enabled, transport: { type } });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup(names = ["ri_http", "ri_stdio"]) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agentex-codex-mcp-"))); dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const env = { ...process.env, CODEX_HOME: dir, MOCK_MCP_LOG: log,
    MOCK_MCP_AMBIENT: JSON.stringify([server("user_stdio"), server("plugin.with.dot", true, "streamable_http")]),
    MOCK_MCP_EFFECTIVE: JSON.stringify([...names.map((name) => server(name)), server("user_stdio", false), server("plugin.with.dot", false, "streamable_http")]),
  } as Record<string, string>;
  return { dir, log, env };
}
const servers: McpServerConfig[] = [
  { name: "ri_http", type: "http", url: "http://127.0.0.1:42241/mcp", headers: { Authorization: "Bearer http-secret", "X-Session-Credential": "signed-secret" } },
  { name: "ri_stdio", command: process.execPath, args: ["-e", "console.log('ready')"], env: { TOKEN: "stdio-secret" } },
];
const records = async (log: string) => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

describe("Codex MCP configuration", () => {
  it("keeps HTTP and stdio credentials in child-only env, disables ambient servers, and preserves auth home", async () => {
    const { env, dir, log } = await setup(); const before = { ...env };
    const prepared = await prepareCodexMcp({ mcpServers: servers }, binary, [], dir, env);
    expect(env).toEqual(before);
    const args = prepared.args.join("\n");
    for (const secret of ["http-secret", "signed-secret", "stdio-secret"]) expect(args).not.toContain(secret);
    expect(prepared.env.CODEX_HOME).toBeUndefined();
    expect(args).toContain('"user_stdio" = { "enabled" = false');
    expect(args).toContain('"plugin.with.dot" = { "enabled" = false');
    expect(args).toContain('"default_tools_approval_mode" = "approve"');
    expect(args).toContain('"bearer_token_env_var"');
    expect(args).toContain('"env_http_headers" = { "X-Session-Credential"');
    expect(Object.values(prepared.env)).toEqual(expect.arrayContaining(["http-secret", "signed-secret", JSON.stringify({ command: process.execPath, args: ["-e", "console.log('ready')"], env: { TOKEN: "stdio-secret" } })]));
    const native = await records(log);
    expect(native.at(-1).env.CODEX_HOME).toBe(dir);
    expect(native.at(-1).args.slice(-3)).toEqual(["mcp", "list", "--json"]);
  });
  it("allows explicit non-strict opt-out while leaving ambient policy untouched", async () => {
    const { env, dir } = await setup();
    env.MOCK_MCP_EFFECTIVE = JSON.stringify([...servers.map((s) => server(s.name)), server("user_stdio")]);
    const prepared = await prepareCodexMcp({ mcpServers: servers, strictMcpConfig: false }, binary, [], dir, env);
    expect(prepared.args.join(" ")).not.toContain('"user_stdio"');
  });
  it("strict with no attached servers blocks the entire ambient configured inventory", async () => {
    const { env, dir } = await setup([]);
    const prepared = await prepareCodexMcp({ strictMcpConfig: true }, binary, [], dir, env);
    expect(prepared.args.join(" ")).toContain('"enabled" = false');
    expect(prepared.env).toEqual({});
  });
  it("does no discovery or subprocess work when MCP config is absent", async () => {
    expect(await prepareCodexMcp({}, { bin: "/does-not-exist", prefixArgs: [] }, [], "/", {})).toEqual({ args: [], env: {} });
  });
  it("uses native config and profile flags consistently and places security overrides last", async () => {
    const { env, dir, log } = await setup();
    const extra = splitCodexExtraArgs(["--listen", "stdio://", "-c", "plugins.demo.enabled=false", "--profile=work", "--enable", "foo"]);
    expect(extra).toEqual({ configArgs: ["-c", "plugins.demo.enabled=false", "--profile=work", "--enable", "foo"], runtimeArgs: ["--listen", "stdio://"] });
    await prepareCodexMcp({ mcpServers: servers }, binary, extra.configArgs, dir, env);
    const calls = await records(log);
    expect(calls[1].args.slice(0, extra.configArgs.length)).toEqual(extra.configArgs);
    expect(calls[2].args.slice(0, extra.configArgs.length)).toEqual(extra.configArgs);
    expect(calls[2].args[extra.configArgs.length]).toBe("-c");
  });
  it.each(["inventory", "leak", "missing", "collision", "old", "invalid"])("fails closed on %s without exposing native credentials", async (failure) => {
    const { env, dir } = await setup();
    if (failure === "inventory") env.MOCK_MCP_FAILURE = "private-native-credential";
    if (failure === "leak") env.MOCK_MCP_EFFECTIVE = JSON.stringify([...servers.map((s) => server(s.name)), server("unexpected")]);
    if (failure === "missing") env.MOCK_MCP_EFFECTIVE = "[]";
    if (failure === "collision") env.MOCK_MCP_AMBIENT = JSON.stringify([server("ri_http")]);
    if (failure === "old") env.MOCK_MCP_VERSION = "0.159.0";
    if (failure === "invalid") env.MOCK_MCP_AMBIENT = JSON.stringify([{ name: "user", enabled: true }]);
    try { await prepareCodexMcp({ mcpServers: servers }, binary, [], dir, env); throw new Error("expected rejection"); }
    catch (error) { expect(String(error)).not.toContain("private-native-credential"); expect(String(error)).not.toContain("expected rejection"); }
  });
  it("rejects unsupported SSE, duplicate/reserved names and URLs with inline credentials", async () => {
    const { env, dir } = await setup();
    for (const mcpServers of [
      [{ name: "legacy", type: "sse", url: "http://localhost" }], [servers[0], servers[0]],
      [{ name: "codex_apps", command: "node" }], [{ name: "inline", type: "http", url: "https://user:secret@localhost" }],
    ] as McpServerConfig[][]) await expect(prepareCodexMcp({ mcpServers }, binary, [], dir, env)).rejects.toThrow();
  });
  it("redacts malformed URLs and invalid headers from configuration errors", async () => {
    const { env, dir } = await setup();
    for (const mcpServers of [
      [{ name: "invalid", type: "http", url: "malformed-private-url-secret" }],
      [{ name: "invalid", type: "http", url: "http://localhost", headers: { Authorization: "private-header-secret\ninvalid" } }],
    ] as McpServerConfig[][]) {
      const error = await prepareCodexMcp({ mcpServers }, binary, [], dir, env).then(() => null, (error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/Codex MCP/);
      expect(String(error)).not.toMatch(/private-url-secret|private-header-secret/);
    }
  });
  it.each([["-C", "/another-project"], ["-C/another-project"], ["--cd=/another-project"], ["--worktree"]])("rejects runtime project changes that discovery cannot verify: %j", async (...extraArgs) => {
    await expect(prepareCodexMcp({ mcpServers: [], extraArgs }, { bin: "/does-not-exist", prefixArgs: [] }, [], "/", {})).rejects.toThrow(/context cwd/);
  });
  it("gates supported runtime versions without a closed list of releases", () => {
    for (const version of ["0.160.0", "codex-cli 0.170.9", "1.0.0"]) expect(codexMcpVersionSupported(version)).toBe(true);
    for (const version of [null, "unknown", "0.159.9"]) expect(codexMcpVersionSupported(version)).toBe(false);
  });
  it("scopes stdio env overlays independently, even when concurrent servers use the same variable", async () => {
    const { env, dir } = await setup(["one", "two"]);
    const prepared = await prepareCodexMcp({ mcpServers: [
      { name: "one", command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({token:process.env.TOKEN,forwarded:Object.keys(process.env).filter(key=>key.startsWith('AGENTEX_CODEX_MCP_'))}))"], env: { TOKEN: "one-secret" } },
      { name: "two", command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({token:process.env.TOKEN,forwarded:Object.keys(process.env).filter(key=>key.startsWith('AGENTEX_CODEX_MCP_'))}))"], env: { TOKEN: "two-secret" } },
    ] }, binary, [], dir, env);
    const payloads = Object.entries(prepared.env).filter(([, value]) => value.startsWith("{"));
    const launcher = JSON.parse(prepared.args[1]!.match(/"args" = \["-e", ("(?:\\.|[^"\\])*"),/s)![1]!);
    const outputs = await Promise.all(payloads.map(async ([key]) => (await promisify(execFile)(process.execPath, ["-e", launcher, key], { env: { ...env, ...prepared.env } })).stdout));
    expect(outputs.map((output) => JSON.parse(output)).sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: "one-secret", forwarded: [] }, { token: "two-secret", forwarded: [] },
    ]);
    expect(prepared.args.join(" ")).not.toContain("one-secret");
    const other = await prepareCodexMcp({ mcpServers: [{ name: "one", command: "node", env: { TOKEN: "other-secret" } }, { name: "two", command: "node" }] }, binary, [], dir, env);
    expect(Object.keys(other.env).some((key) => key in prepared.env)).toBe(false);
  });
  it("snapshots public config arguments and env references for HTTP and plain stdio", async () => {
    const { env, dir } = await setup();
    const prepared = await prepareCodexMcp({ mcpServers: [servers[0]!, { name: "ri_stdio", command: process.execPath, args: ["stdio-server.js"] }] }, binary, [], dir, env);
    let arg = prepared.args[1]!.replaceAll(process.execPath, "<node>");
    const values: Record<string, string> = {};
    Object.entries(prepared.env).forEach(([name, value], i) => { arg = arg.replaceAll(name, `ENV_${i}`); values[`ENV_${i}`] = value; });
    expect({ args: ["-c", arg], env: values }).toMatchInlineSnapshot(`
      {
        "args": [
          "-c",
          "mcp_servers={ "user_stdio" = { "enabled" = false, "command" = "<node>" }, "plugin.with.dot" = { "enabled" = false, "url" = "http://127.0.0.1:9/" }, "ri_http" = { "enabled" = true, "default_tools_approval_mode" = "approve", "url" = "http://127.0.0.1:42241/mcp", "bearer_token_env_var" = "ENV_0", "env_http_headers" = { "X-Session-Credential" = "ENV_1" } }, "ri_stdio" = { "enabled" = true, "default_tools_approval_mode" = "approve", "command" = "<node>", "args" = ["stdio-server.js"] } }",
        ],
        "env": {
          "ENV_0": "http-secret",
          "ENV_1": "signed-secret",
        },
      }
    `);
  });
  it.each([false, true])("applies MCP settings before app-server for a resumed thread: %s", async (resume) => {
    const { env, dir, log } = await setup();
    const session = await createCodexSession({ cwd: dir, env, config: { command: fixture, mcpServers: servers },
      ...(resume ? { sessionParams: { sessionId: "old-thread" } } : {}) });
    try { expect(session.sessionId).toBe(resume ? "old-thread" : "mcp-session"); }
    finally { await session.close(); }
    const calls = await records(log); const spawn = calls.find((call) => call.args?.includes("app-server"));
    expect(spawn.args.findIndex((arg: string) => arg.startsWith("mcp_servers="))).toBeLessThan(spawn.args.indexOf("app-server"));
    expect(calls.some((call) => call.rpc?.method === (resume ? "thread/resume" : "thread/start"))).toBe(true);
    expect(calls.find((call) => call.rpc?.method === (resume ? "thread/resume" : "thread/start")).rpc.params.cwd).toBe(dir);
    expect(spawn.args.join(" ")).not.toContain("signed-secret");
  });
  it("uses restored cwd for MCP-configured session and execution resumes when no context cwd is supplied", async () => {
    const { env, dir, log } = await setup();
    const ctx = { env, config: { command: fixture, mcpServers: servers }, sessionParams: { sessionId: "old-thread", cwd: dir } };
    const session = await createCodexSession(ctx);
    await session.close();
    await executeCodexProvider({ ...ctx, prompt: "test" });
    const calls = await records(log);
    for (const call of calls.filter((call) => call.args)) expect(call.cwd).toBe(dir);
    expect(calls.find((call) => call.rpc?.method === "thread/resume").rpc.params.cwd).toBe(dir);
  });
  it("cleans a newly prepared execution workspace when MCP verification fails before startup", async () => {
    const { env, dir } = await setup();
    const git = (args: string[]) => promisify(execFile)("git", args, { cwd: dir });
    await git(["init", "-q"]);
    await git(["-c", "user.name=MCP Test", "-c", "user.email=mcp-test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"]);
    env.MOCK_MCP_VERSION = "0.159.0";
    const workspace = join(dir, "prepared-workspace");
    await expect(executeCodexProvider({ prompt: "test", cwd: dir, env, config: {
      command: fixture, mcpServers: servers,
      workspace: { strategy: "worktree", branchName: "mcp-test-workspace", targetDir: workspace },
    } })).rejects.toThrow(/0.160/);
    expect(await stat(workspace).catch(() => null)).toBeNull();
    expect((await git(["branch", "--list", "mcp-test-workspace"])).stdout).toBe("");
  });
  it.each([false, true])("applies the same MCP configuration to execute and execute resume: %s", async (resume) => {
    const { env, dir, log } = await setup();
    const result = await executeCodexProvider({ prompt: "test", cwd: dir, env, config: { command: fixture, mcpServers: servers },
      ...(resume ? { sessionParams: { sessionId: "old-thread", cwd: dir } } : {}) });
    expect(result.status).toBe("completed");
    const spawn = (await records(log)).find((call) => call.args?.includes("exec"));
    expect(spawn.args.findIndex((arg: string) => arg.startsWith("mcp_servers="))).toBeLessThan(spawn.args.indexOf("exec"));
    expect(spawn.args.includes("resume")).toBe(resume);
    expect(spawn.args.join(" ")).not.toContain("http-secret");
    expect(spawn.env.CODEX_HOME).toBe(dir);
  });
});
