/**
 * Approval policy and sandbox for Codex app-server sessions.
 *
 * `codex app-server` drops `--sandbox` and
 * `--dangerously-bypass-approvals-and-sandbox` (TUI flags the subcommand never
 * receives), so sessions spawned with them ran on Codex's defaults: approvals
 * on, sandboxed. The settings now go in as root `-c` overrides and on the
 * thread itself. These tests pin both channels against a mock app-server.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCodexSession } from "../../../src/providers/codex/session.js";
import {
  codexPermissionConfigArgs,
  codexPermissionThreadParams,
  codexThreadPermissions,
} from "../../../src/providers/codex/permissions.js";
import type { ProviderConfig } from "../../../src/types.js";

const MOCK_APP_SERVER = path.resolve(import.meta.dirname, "../../fixtures/mock-codex-app-server.sh");

describe("codexThreadPermissions", () => {
  it("runs skipPermissions with no approvals and full access", () => {
    expect(codexThreadPermissions({ skipPermissions: true })).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("runs plan mode read-only and leaves approvals on", () => {
    expect(codexThreadPermissions({ planMode: true })).toEqual({ sandbox: "read-only" });
  });

  it("lets plan mode win over skipPermissions", () => {
    expect(codexThreadPermissions({ planMode: true, skipPermissions: true })).toEqual({ sandbox: "read-only" });
  });

  it("leaves Codex's own defaults when neither is set", () => {
    expect(codexThreadPermissions({})).toEqual({});
    expect(codexThreadPermissions(undefined)).toEqual({});
  });

  it("renders the settings as TOML-valued -c overrides and as thread params", () => {
    const permissions = codexThreadPermissions({ skipPermissions: true });
    expect(codexPermissionConfigArgs(permissions)).toEqual([
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="danger-full-access"',
    ]);
    expect(codexPermissionThreadParams(permissions)).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(codexPermissionConfigArgs({})).toEqual([]);
    expect(codexPermissionThreadParams({})).toEqual({});
  });
});

describe("createCodexSession permissions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-permissions-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function spawnWith(config: ProviderConfig, sessionParams?: Record<string, unknown>) {
    const argsFile = path.join(dir, "args.txt");
    const requestsFile = path.join(dir, "requests.jsonl");
    const session = await createCodexSession({
      cwd: dir,
      config: { command: MOCK_APP_SERVER, ...config },
      env: { MOCK_DUMP_ARGS_TO: argsFile, MOCK_DUMP_REQUESTS_TO: requestsFile },
      ...(sessionParams ? { sessionParams } : {}),
    });
    await session.close();
    const args = (await fs.readFile(argsFile, "utf-8")).split("\n").filter(Boolean);
    const requests = (await fs.readFile(requestsFile, "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const paramsFor = (method: string) => requests.find((r) => r.method === method)?.params ?? {};
    return { args, paramsFor };
  }

  it("sends skipPermissions as -c overrides before app-server, never as the ignored flag", async () => {
    const { args, paramsFor } = await spawnWith({ skipPermissions: true });
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    const subcommand = args.indexOf("app-server");
    expect(subcommand).toBeGreaterThan(0);
    expect(args.slice(0, subcommand)).toEqual([
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="danger-full-access"',
    ]);
    expect(paramsFor("thread/start")).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  it("sends plan mode as a read-only sandbox, never as the ignored --sandbox flag", async () => {
    const { args, paramsFor } = await spawnWith({ planMode: true, skipPermissions: true });
    expect(args).not.toContain("--sandbox");
    expect(args.slice(0, args.indexOf("app-server"))).toEqual(["-c", 'sandbox_mode="read-only"']);
    const start = paramsFor("thread/start");
    expect(start["sandbox"]).toBe("read-only");
    expect(start).not.toHaveProperty("approvalPolicy");
  });

  it("leaves both unset without a permission mode", async () => {
    const { args, paramsFor } = await spawnWith({});
    expect(args[0]).toBe("app-server");
    const start = paramsFor("thread/start");
    expect(start).not.toHaveProperty("approvalPolicy");
    expect(start).not.toHaveProperty("sandbox");
  });

  it("applies the session's settings to a resumed thread created under others", async () => {
    const { paramsFor } = await spawnWith({ skipPermissions: true }, { sessionId: "thr_existing" });
    expect(paramsFor("thread/resume")).toMatchObject({
      threadId: "thr_existing",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});
