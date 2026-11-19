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
  openCodeConfigServerNames,
  openCodeMcpServerEntry,
  prepareOpenCodeMcp,
  withOpenCodeMcpConfig,
} from "../../../src/providers/opencode/mcp-config.js";

const BINARY = { bin: "/usr/local/bin/opencode", prefixArgs: [] };
const HOST: McpServerConfig[] = [
  { name: "ri", type: "http", url: "http://127.0.0.1:4224/api/orchestrator/mcp", headers: { Authorization: "Bearer tok" } },
];

/** A `GET /api/config` payload: one document per source, in load order. */
function sources(...documents: Array<Record<string, unknown> | null>): unknown {
  return documents.map((servers, index) => servers === null
    ? { type: "directory", path: `/config/${index}` }
    : { type: "document", path: index === documents.length - 1 ? null : `/config/${index}/opencode.json`, info: { mcp: { servers } } });
}

function fakeServer(config: unknown | (() => unknown)) {
  return {
    client: {
      json: vi.fn(async (path: string) => {
        if (path !== "/api/config") throw new Error(`unexpected ${path}`);
        const value = typeof config === "function" ? (config as () => unknown)() : config;
        if (value instanceof Error) throw value;
        return value;
      }),
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

  it("merges into existing inline config and disables named servers", () => {
    const env = withOpenCodeMcpConfig(
      { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude", mcp: { servers: { mine: { type: "local", command: ["x"] } } } }) },
      HOST,
      ["mine", "global"],
    );
    expect(env["PATH"]).toBe("/bin");
    expect(content(env)).toEqual({
      model: "anthropic/claude",
      mcp: {
        servers: {
          mine: { type: "remote", url: "http://127.0.0.1:9/", disabled: true },
          global: { type: "remote", url: "http://127.0.0.1:9/", disabled: true },
          ri: { type: "remote", url: "http://127.0.0.1:4224/api/orchestrator/mcp", headers: { Authorization: "Bearer tok" } },
        },
      },
    });
    expect(() => withOpenCodeMcpConfig({ OPENCODE_CONFIG_CONTENT: "[1]" }, HOST)).toThrow(/JSON object/);
    expect(() => withOpenCodeMcpConfig({ OPENCODE_CONFIG_CONTENT: "{" }, HOST)).toThrow(/valid JSON/);
  });

  it("reads server names from every config source", () => {
    expect([...openCodeConfigServerNames(sources({ global: {} }, null, { project: {} }, { ri: {} }))].sort())
      .toEqual(["global", "project", "ri"]);
    expect([...openCodeConfigServerNames({ data: [{ info: { mcp: { legacy: {} } } }] })]).toEqual(["legacy"]);
    expect([...openCodeConfigServerNames(null)]).toEqual([]);
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

  it("keeps the first server when nothing ambient is configured", async () => {
    const server = fakeServer(sources(null, { ri: {} }));
    mocks.acquire.mockResolvedValue(server);
    const prepared = await prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" });
    expect(prepared.server).toBe(server);
    expect(server.release).not.toHaveBeenCalled();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).toHaveBeenCalledWith(BINARY.bin, [], prepared.env, "/repo");
    expect(Object.keys((content(prepared.env)["mcp"] as { servers: object }).servers)).toEqual(["ri"]);
  });

  it("restarts with every ambient server disabled", async () => {
    const first = fakeServer(sources({ global: {} }, { project: {} }, { ri: {} }));
    const second = fakeServer(sources({ global: {} }, { project: {} }, { ri: {}, global: {}, project: {} }));
    mocks.acquire.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const prepared = await prepareOpenCodeMcp({ config: { mcpServers: HOST, strictMcpConfig: true }, binary: BINARY, env: {}, cwd: "/repo" });
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(prepared.server).toBe(second);
    expect(second.release).not.toHaveBeenCalled();
    expect((content(prepared.env)["mcp"] as { servers: object }).servers).toEqual({
      global: { type: "remote", url: "http://127.0.0.1:9/", disabled: true },
      project: { type: "remote", url: "http://127.0.0.1:9/", disabled: true },
      ri: { type: "remote", url: "http://127.0.0.1:4224/api/orchestrator/mcp", headers: { Authorization: "Bearer tok" } },
    });
    expect(mocks.acquire.mock.calls[1]).toEqual([BINARY.bin, [], prepared.env, "/repo"]);
  });

  it("isolates with no host servers when only strict is asked", async () => {
    const first = fakeServer(sources({ global: {} }));
    const second = fakeServer(sources({ global: {} }, { global: {} }));
    mocks.acquire.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const prepared = await prepareOpenCodeMcp({ config: { strictMcpConfig: true }, binary: BINARY, env: {}, cwd: "/repo" });
    expect((content(prepared.env)["mcp"] as { servers: object }).servers).toEqual({ global: { type: "remote", url: "http://127.0.0.1:9/", disabled: true } });
  });

  it("fails closed when the config sources can't be read", async () => {
    const server = fakeServer(new Error("404"));
    mocks.acquire.mockResolvedValue(server);
    await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
      .rejects.toBeInstanceOf(OpenCodeMcpIsolationError);
    expect(server.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a server appears between the two reads", async () => {
    const first = fakeServer(sources({ global: {} }, { ri: {} }));
    const second = fakeServer(sources({ global: {}, late: {} }, { ri: {}, global: {} }));
    mocks.acquire.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(prepareOpenCodeMcp({ config: { mcpServers: HOST }, binary: BINARY, env: {}, cwd: "/repo" }))
      .rejects.toThrow(/changed while it was being isolated/);
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});
