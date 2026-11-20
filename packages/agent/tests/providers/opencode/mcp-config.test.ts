import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../src/types.js";

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), isV2: vi.fn() }));
vi.mock("../../../src/providers/opencode/server.js", () => ({ acquireOpenCodeServer: mocks.acquire }));
vi.mock("../../../src/providers/opencode/v2.js", async (original) => ({
  ...(await original<object>()),
  isOpenCodeV2Binary: mocks.isV2,
}));

import { OpenCodeMcpIsolationError } from "../../../src/types.js";
import {
  openCodeMcpServerEntry,
  prepareOpenCodeMcp,
  withOpenCodeMcpConfig,
} from "../../../src/providers/opencode/mcp-config.js";

const BINARY = { bin: "/usr/local/bin/opencode", prefixArgs: [] };
const HOST: McpServerConfig[] = [
  { name: "ri", type: "http", url: "http://127.0.0.1:4224/api/orchestrator/mcp", headers: { Authorization: "Bearer tok" } },
];

const KEEP_LOCATION = { location_idle_timeout: false };
const INLINE = { type: "document", info: { plugins: ["-opencode.config.mcp"], experimental: KEEP_LOCATION } };

function fakeServer(config: unknown, serverVersion = "2.3.0") {
  return {
    apiVersion: 2,
    serverVersion,
    client: {
      json: vi.fn(async (path: string) => {
        if (path !== "/api/config") throw new Error(`unexpected ${path}`);
        if (config instanceof Error) throw config;
        return config;
      }),
      ok: vi.fn(async () => {}),
    },
    release: vi.fn(),
  };
}

function content(env: Record<string, string>): Record<string, unknown> {
  return JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!);
}

describe("OpenCode MCP config", () => {
  beforeEach(() => {
    mocks.acquire.mockReset();
    mocks.isV2.mockReset();
    mocks.isV2.mockResolvedValue(true);
  });

  it("maps host servers to OpenCode 2 entries", () => {
    expect(openCodeMcpServerEntry({ name: "a", type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } }))
      .toEqual({ type: "remote", url: "http://x/mcp", headers: { Authorization: "Bearer t" } });
    expect(openCodeMcpServerEntry({ name: "b", type: "sse", url: "https://x/sse" }))
      .toEqual({ type: "remote", url: "https://x/sse" });
    expect(openCodeMcpServerEntry({ name: "c", command: "node", args: ["server.js"], env: { TOKEN: "t" } }))
      .toEqual({ type: "local", command: ["node", "server.js"], environment: { TOKEN: "t" } });
    expect(openCodeMcpServerEntry({ name: "d", command: "mcp-files" }))
      .toEqual({ type: "local", command: ["mcp-files"] });
    expect(() => openCodeMcpServerEntry({ name: "e", type: "http", url: "file:///etc/passwd" })).toThrow(/HTTP\(S\)/);
    expect(() => openCodeMcpServerEntry({ name: "f", type: "http", url: "not a url" })).toThrow(/valid/);
  });

  it("merges into existing inline config when isolation is off", () => {
    const env = withOpenCodeMcpConfig(
      { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude", mcp: { servers: { mine: { type: "local", command: ["x"] } } } }) },
      HOST,
    );
    expect(env["PATH"]).toBe("/bin");
    expect(content(env)).toEqual({
      model: "anthropic/claude",
      mcp: {
        servers: {
          mine: { type: "local", command: ["x"] },
          ri: { type: "remote", url: "http://127.0.0.1:4224/api/orchestrator/mcp", headers: { Authorization: "Bearer tok" } },
        },
      },
    });
    expect(() => withOpenCodeMcpConfig({ OPENCODE_CONFIG_CONTENT: "[1]" }, HOST)).toThrow(/JSON object/);
    expect(() => withOpenCodeMcpConfig({ OPENCODE_CONFIG_CONTENT: "{" }, HOST)).toThrow(/valid JSON/);
  });

  it("leaves OpenCode alone without MCP options", async () => {
    const env = { PATH: "/bin" };
    await expect(prepareOpenCodeMcp({ config: {}, binary: BINARY, env, cwd: "/repo" })).resolves.toEqual({ env, server: null });
    expect(mocks.isV2).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("refuses duplicate or empty server names", async () => {
    await expect(prepareOpenCodeMcp({ config: { mcpServers: [...HOST, ...HOST] }, binary: BINARY, env: {}, cwd: "/repo" })).rejects.toThrow(/unique/);
    await expect(prepareOpenCodeMcp({ config: { mcpServers: [{ name: "", command: "x" }] }, binary: BINARY, env: {}, cwd: "/repo" })).rejects.toThrow(/unique/);
  });

  it("runs OpenCode 1 without host servers and says so", async () => {
    mocks.isV2.mockResolvedValue(false);
    const notices: string[] = [];
    const env = { PATH: "/bin" };
    const prepared = await prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env, cwd: "/repo", onNotice: (m) => notices.push(m) });
    expect(prepared).toEqual({ env, server: null });
    expect(notices.join("")).toMatch(/needs OpenCode 2/);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("adds host servers without a server start when isolation is off", async () => {
    const prepared = await prepareOpenCodeMcp({ config: { mcpServers: HOST, strictMcpConfig: false }, binary: BINARY, env: {}, cwd: "/repo" });
    expect(prepared.server).toBeNull();
    expect(Object.keys((content(prepared.env)["mcp"] as { servers: object }).servers)).toEqual(["ri"]);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("disables the native config plugin and registers only host servers on the same server", async () => {
    const server = fakeServer([
      { type: "directory", path: "/config" },
      { type: "document", path: "/repo/opencode.json", info: { plugins: ["*"] } },
      INLINE,
      { type: "document", path: "/system/opencode.json", info: {
        mcp: { servers: { ri: { type: "remote", url: "http://ambient" }, other: { type: "local", command: ["ambient"] } } },
      } },
    ]);
    mocks.acquire.mockResolvedValue(server);
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "my-model", plugins: ["-opencode.formatter"] }) };
    const prepared = await prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env, cwd: "/repo" });
    expect(prepared.server).toBe(server);
    expect(server.release).not.toHaveBeenCalled();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).toHaveBeenCalledWith(BINARY.bin, [], prepared.env, "/repo", expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(prepared.env["OPENCODE_FILEWATCHER_DISABLE"]).toBe("1");
    expect(content(prepared.env)).toEqual({
      model: "my-model", plugins: ["-opencode.formatter", "-opencode.config.mcp"], experimental: KEEP_LOCATION,
    });
    expect(server.client.ok).toHaveBeenCalledExactlyOnceWith("/api/experimental/mcp/ri", {
      method: "PUT", body: JSON.stringify({ config: openCodeMcpServerEntry(HOST[0]!) }), signal: expect.any(AbortSignal),
    });
  });

  it("isolates with no host servers when only strict is asked", async () => {
    const server = fakeServer([INLINE]);
    mocks.acquire.mockResolvedValue(server);
    const prepared = await prepareOpenCodeMcp({ config: { strictMcpConfig: true }, binary: BINARY, env: {}, cwd: "/repo" });
    expect(prepared.server).toBe(server);
    expect(server.client.ok).not.toHaveBeenCalled();
  });

  it("fails closed when the config sources can't be read", async () => {
    const server = fakeServer(new Error("404"));
    mocks.acquire.mockResolvedValue(server);
    await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
      .rejects.toBeInstanceOf(OpenCodeMcpIsolationError);
    expect(server.release).toHaveBeenCalledTimes(1);
  });

  it.each(["opencode.config.mcp", "opencode.config.*", "*", { package: "opencode.config.mcp" }])(
    "fails closed before registering anything when managed config re-enables the MCP plugin (%j)",
    async (selector) => {
      const server = fakeServer([INLINE, { type: "document", path: "/system/opencode.json", info: { plugins: [selector] } }]);
      mocks.acquire.mockResolvedValue(server);
      await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
        .rejects.toThrow(/managed settings/);
      expect(server.client.ok).not.toHaveBeenCalled();
      expect(server.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, [], [{ type: "document" }], [{ ...INLINE, path: "/repo/opencode.json" }]])(
    "fails closed when the config response does not prove the inline directive (%j)",
    async (payload) => {
      const server = fakeServer(payload);
      mocks.acquire.mockResolvedValue(server);
      await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
        .rejects.toBeInstanceOf(OpenCodeMcpIsolationError);
      expect(server.client.ok).not.toHaveBeenCalled();
      expect(server.release).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a v2 binary below the qualified strict isolation version", async () => {
    const server = fakeServer([INLINE], "2.2.0");
    mocks.acquire.mockResolvedValue(server);
    await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
      .rejects.toThrow(/2\.3\.0/);
    expect(server.client.ok).not.toHaveBeenCalled();
    expect(server.release).toHaveBeenCalledTimes(1);
  });
});
