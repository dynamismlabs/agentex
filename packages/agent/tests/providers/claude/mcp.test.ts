import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import {
  buildMcpConfigJson,
  stageMcpConfig,
  cleanupMcpConfig,
  claudeFeatureArgs,
} from "../../../src/providers/claude/mcp.js";
import { ClaudeSessionImpl } from "../../../src/providers/claude/session.js";
import { getProvider } from "../../../src/index.js";
import type { McpServerConfig } from "../../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = path.resolve(__dirname, "../../fixtures/mock-claude.sh");

const stdioServer: McpServerConfig = {
  name: "files",
  command: "node",
  args: ["server.js"],
  env: { DEBUG: "1" },
};
const httpServer: McpServerConfig = {
  name: "orchestrator",
  type: "http",
  url: "http://localhost:8123/mcp",
  headers: { Authorization: "Bearer tok" },
};
const sseServer: McpServerConfig = {
  name: "events",
  type: "sse",
  url: "http://localhost:9000/sse",
};

function makeFakeProc(): ChildProcess {
  const stdin = { write: () => true, end: () => {} };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      setImmediate(() => (proc as unknown as EventEmitter).emit("exit", 0, null));
      return true;
    },
    killed: false,
  });
  return proc;
}

describe("buildMcpConfigJson", () => {
  it("maps a stdio server (default arm) to Claude's shape", () => {
    expect(buildMcpConfigJson([stdioServer])).toEqual({
      mcpServers: {
        files: { type: "stdio", command: "node", args: ["server.js"], env: { DEBUG: "1" } },
      },
    });
  });

  it("maps an http server with auth headers", () => {
    expect(buildMcpConfigJson([httpServer])).toEqual({
      mcpServers: {
        orchestrator: {
          type: "http",
          url: "http://localhost:8123/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
  });

  it("maps sse + multiple servers together", () => {
    const json = buildMcpConfigJson([stdioServer, httpServer, sseServer]);
    expect(Object.keys(json.mcpServers)).toEqual(["files", "orchestrator", "events"]);
    expect(json.mcpServers["events"]).toEqual({ type: "sse", url: "http://localhost:9000/sse" });
  });
});

describe("claudeFeatureArgs", () => {
  it("emits --mcp-config <path> (+ strict) and never --mcp-server", () => {
    const args = claudeFeatureArgs({ strictMcpConfig: true }, "/tmp/x/mcp-config.json");
    expect(args).toEqual(["--mcp-config", "/tmp/x/mcp-config.json", "--strict-mcp-config"]);
    expect(args).not.toContain("--mcp-server");
  });

  it("strict works without an attached config (blocks ambient MCP)", () => {
    expect(claudeFeatureArgs({ strictMcpConfig: true }, null)).toEqual(["--strict-mcp-config"]);
  });

  it("emits tool allow/deny comma-joined, patterns verbatim", () => {
    expect(
      claudeFeatureArgs(
        {
          allowedTools: ["Bash(ls *)", "mcp__orchestrator__*"],
          disallowedTools: ["Write", "Edit", "NotebookEdit"],
        },
        null,
      ),
    ).toEqual([
      "--allowed-tools",
      "Bash(ls *),mcp__orchestrator__*",
      "--disallowed-tools",
      "Write,Edit,NotebookEdit",
    ]);
  });

  it("emits --include-partial-messages when opted in", () => {
    expect(claudeFeatureArgs({ includePartialMessages: true }, null)).toEqual([
      "--include-partial-messages",
    ]);
  });

  it("emits nothing by default", () => {
    expect(claudeFeatureArgs({}, null)).toEqual([]);
  });
});

describe("stageMcpConfig / cleanupMcpConfig", () => {
  it("stages mcp-config.json at mode 0600; cleanup removes it (idempotent, null-safe)", async () => {
    const file = await stageMcpConfig([stdioServer, httpServer]);
    expect(path.basename(file)).toBe("mcp-config.json");

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as ReturnType<typeof buildMcpConfigJson>;
    expect(parsed.mcpServers["orchestrator"]!["headers"]).toEqual({ Authorization: "Bearer tok" });

    await cleanupMcpConfig(file);
    await expect(fs.stat(file)).rejects.toThrow();
    await cleanupMcpConfig(file); // idempotent
    await cleanupMcpConfig(null); // null-safe
  });
});

describe("lifecycle cleanup", () => {
  it("session close() removes the staged config", async () => {
    const file = await stageMcpConfig([httpServer]);
    const session = new ClaudeSessionImpl(makeFakeProc(), { config: { graceSec: 0.05 } }, null, file);
    await session.close();
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("execute() with mcpServers completes (mock) and leaves no agentex-mcp temp dirs", async () => {
    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("agentex-mcp-")),
    );
    const result = await getProvider("claude").execute({
      prompt: "hi",
      config: { command: MOCK_CLAUDE, skipPermissions: true, timeoutSec: 30, mcpServers: [httpServer] },
      env: { MOCK_BEHAVIOR: "success" },
    });
    expect(result.status).toBe("completed");

    const leaked = (await fs.readdir(os.tmpdir()))
      .filter((d) => d.startsWith("agentex-mcp-"))
      .filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
  });
});
