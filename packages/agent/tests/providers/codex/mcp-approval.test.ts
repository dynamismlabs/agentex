/**
 * `mcpServer/elicitation/request`, against the shape codex 0.160 sends.
 *
 * Codex asks with this request before an MCP or app tool call that needs a yes
 * (`_meta.codex_approval_kind: "mcp_tool_call"`), and MCP servers use it for
 * forms and URLs. It used to fall through to the generic `{}` reply, which
 * Codex read as a decline: every GitHub app write failed as "user rejected MCP
 * tool call" with nobody asked.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import type {
  ElicitationRequest,
  ElicitationResponse,
  SessionContext,
  UserInputRequest,
} from "../../../src/types.js";

function session(ctx: Partial<SessionContext> = {}) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const writes: Record<string, unknown>[] = [];
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, {
    stdin: {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) writes.push(JSON.parse(line) as Record<string, unknown>);
        }
        return true;
      },
      end: () => {},
    },
    stdout,
    stderr,
    kill: () => true,
  });
  const impl = new CodexSessionImpl(proc, ctx, "/tmp", "test-model", null);
  (impl as unknown as { _threadId: string | null })._threadId = "root-thread";
  (impl as unknown as { _state: string })._state = "thinking";
  const replyTo = (id: number) => writes.find((w) => w["id"] === id && !("method" in w));
  return { impl, writes, replyTo };
}

const feed = async (impl: CodexSessionImpl, message: unknown) => {
  (impl as unknown as { handleLine: (l: string) => void }).handleLine(JSON.stringify(message));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

const createBranchArgs = {
  repository_full_name: "acme/web",
  branch_name: "fix/login",
  base_ref: "main",
};

/** `item/started` for an app tool call, as Codex reports it before asking. */
const mcpCallStarted = (itemId: string, opts: { threadId?: string; tool?: string; args?: unknown } = {}) => ({
  jsonrpc: "2.0",
  method: "item/started",
  params: {
    threadId: opts.threadId ?? "root-thread",
    turnId: "turn-1",
    item: {
      type: "mcpToolCall",
      id: itemId,
      server: "codex_apps",
      tool: opts.tool ?? "github.create_branch",
      status: "inProgress",
      arguments: opts.args ?? createBranchArgs,
      readOnlyHint: false,
    },
  },
});

const mcpCallCompleted = (itemId: string) => ({
  jsonrpc: "2.0",
  method: "item/completed",
  params: {
    threadId: "root-thread",
    turnId: "turn-1",
    item: {
      type: "mcpToolCall",
      id: itemId,
      server: "codex_apps",
      tool: "github.create_branch",
      status: "completed",
      arguments: createBranchArgs,
      result: { content: [{ type: "text", text: "Branch created." }] },
    },
  },
});

/** The approval Codex sends for that call (codex-rs `build_mcp_tool_approval_elicitation_request`). */
const toolApproval = (id: number, opts: { threadId?: string; params?: unknown } = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "mcpServer/elicitation/request",
  params: {
    serverName: "codex_apps",
    threadId: opts.threadId ?? "root-thread",
    turnId: "turn-1",
    mode: "form",
    message: 'Allow GitHub to run tool "create_branch"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_title: "Create branch",
      source: "connector",
      connector_id: "connector_github",
      connector_name: "GitHub",
      tool_params: opts.params ?? createBranchArgs,
      tool_params_display: [
        { name: "base_ref", display_name: "Base ref", value: "main" },
        { name: "branch_name", display_name: "Branch name", value: "fix/login" },
        { name: "repository_full_name", display_name: "Repository", value: "acme/web" },
      ],
    },
  },
});

describe("MCP tool approvals", () => {
  it("asks the host as a tool permission and accepts when allowed", async () => {
    let seen: UserInputRequest | null = null;
    let stateDuring: string | null = null;
    const { impl, replyTo } = session({
      onUserInputRequest: async (request) => {
        seen = request;
        stateDuring = impl.state;
        return { allow: true };
      },
    });
    await feed(impl, mcpCallStarted("call-1"));
    await feed(impl, toolApproval(7));

    expect(seen).toMatchObject({
      toolName: "mcp__codex_apps__github_create_branch",
      toolUseId: "call-1",
      input: createBranchArgs,
      title: 'Allow GitHub to run tool "create_branch"?',
      displayName: "Create branch",
      description: "Base ref: main · Branch name: fix/login · Repository: acme/web",
    });
    expect(stateDuring).toBe("waiting_for_approval");
    // No turn in flight in this harness, so the session settles to idle.
    expect(impl.state).toBe("idle");
    expect(replyTo(7)).toEqual({ jsonrpc: "2.0", id: 7, result: { action: "accept" } });
  });

  it("declines when the host denies", async () => {
    const { impl, replyTo } = session({ onUserInputRequest: async () => ({ allow: false, message: "not now" }) });
    await feed(impl, mcpCallStarted("call-1"));
    await feed(impl, toolApproval(8));
    expect(replyTo(8)?.["result"]).toEqual({ action: "decline" });
  });

  it("declines when the host handler throws", async () => {
    const { impl, replyTo } = session({
      onUserInputRequest: async () => { throw new Error("host went away"); },
    });
    await feed(impl, mcpCallStarted("call-1"));
    await feed(impl, toolApproval(9));
    expect(replyTo(9)?.["result"]).toEqual({ action: "decline" });
    expect(impl.state).toBe("idle");
  });

  it("accepts without a host handler, like every other approval", async () => {
    const { impl, replyTo } = session();
    await feed(impl, toolApproval(10));
    expect(replyTo(10)?.["result"]).toEqual({ action: "accept" });
  });

  it("never answers with the empty result Codex reads as a refusal", async () => {
    const { impl, replyTo } = session({ onUserInputRequest: async () => ({ allow: true }) });
    await feed(impl, toolApproval(11));
    expect(replyTo(11)?.["result"]).toHaveProperty("action");
  });

  it("pairs the approval with the in-flight call whose arguments match", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session({ onUserInputRequest: async (request) => { seen = request; return { allow: true }; } });
    const otherArgs = { repository_full_name: "acme/api", branch_name: "chore/deps", base_ref: "main" };
    await feed(impl, mcpCallStarted("call-a", { args: createBranchArgs }));
    await feed(impl, mcpCallStarted("call-b", { args: otherArgs }));
    // Key order differs from the started item: matching is by value.
    await feed(impl, toolApproval(12, { params: { base_ref: "main", branch_name: "fix/login", repository_full_name: "acme/web" } }));
    expect(seen!.toolUseId).toBe("call-a");
  });

  it("falls back to the most recently started call on that server", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session({ onUserInputRequest: async (request) => { seen = request; return { allow: true }; } });
    await feed(impl, mcpCallStarted("call-a"));
    await feed(impl, mcpCallStarted("call-b", { tool: "github.update_pull_request", args: { number: 3 } }));
    await feed(impl, toolApproval(13, { params: { rendered: "by a template" } }));
    expect(seen).toMatchObject({ toolUseId: "call-b", toolName: "mcp__codex_apps__github_update_pull_request" });
  });

  it("forgets a call once it completes", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session({ onUserInputRequest: async (request) => { seen = request; return { allow: true }; } });
    await feed(impl, mcpCallStarted("call-1"));
    await feed(impl, mcpCallCompleted("call-1"));
    await feed(impl, toolApproval(14));
    expect(seen!.toolUseId).not.toBe("call-1");
  });

  it("gives an unmatched approval a fresh id every time, since hosts key on it", async () => {
    const seen: UserInputRequest[] = [];
    const { impl } = session({ onUserInputRequest: async (request) => { seen.push(request); return { allow: true }; } });
    await feed(impl, toolApproval(15));
    await feed(impl, toolApproval(16));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.toolUseId).toMatch(/^codex-mcp-approval-/);
    expect(seen[0]!.toolUseId).not.toBe(seen[1]!.toolUseId);
    // The server is still named, and the input still comes from the request.
    expect(seen[0]).toMatchObject({ toolName: "mcp__codex_apps", input: createBranchArgs });
  });

  it("attributes a child thread's approval to that subagent without blocking root state", async () => {
    let seen: UserInputRequest | null = null;
    const { impl, replyTo } = session({
      onUserInputRequest: async (request) => {
        seen = request;
        expect(impl.state).toBe("thinking");
        return { allow: true };
      },
    });
    await feed(impl, mcpCallStarted("child-call", { threadId: "child-thread" }));
    await feed(impl, toolApproval(17, { threadId: "child-thread" }));
    expect(seen).toMatchObject({ toolUseId: "child-call", agentId: "child-thread" });
    expect(replyTo(17)?.["result"]).toEqual({ action: "accept" });
  });
});

const formElicitation = (id: number, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "mcpServer/elicitation/request",
  params: {
    serverName: "deploys",
    threadId: "root-thread",
    turnId: "turn-1",
    mode: "form",
    message: "Which environment?",
    requestedSchema: {
      type: "object",
      properties: { env: { type: "string", enum: ["staging", "production"] } },
    },
    ...extra,
  },
});

describe("MCP elicitations", () => {
  it("declines without an onElicitation handler", async () => {
    const { impl, replyTo } = session({ onUserInputRequest: async () => ({ allow: true }) });
    await feed(impl, formElicitation(20));
    expect(replyTo(20)?.["result"]).toEqual({ action: "decline" });
  });

  it("passes a form to onElicitation and returns the content on accept", async () => {
    let seen: ElicitationRequest | null = null;
    let stateDuring: string | null = null;
    const { impl, replyTo } = session({
      onElicitation: async (request): Promise<ElicitationResponse> => {
        seen = request;
        stateDuring = impl.state;
        return { action: "accept", content: { env: "staging" } };
      },
    });
    await feed(impl, formElicitation(21));
    expect(seen).toEqual({
      mcpServerName: "deploys",
      message: "Which environment?",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { env: { type: "string", enum: ["staging", "production"] } },
      },
    });
    expect(stateDuring).toBe("waiting_for_input");
    expect(impl.state).toBe("idle");
    expect(replyTo(21)?.["result"]).toEqual({ action: "accept", content: { env: "staging" } });
  });

  it("passes a URL request through with its id", async () => {
    let seen: ElicitationRequest | null = null;
    const { impl, replyTo } = session({
      onElicitation: async (request) => { seen = request; return { action: "decline", content: { ignored: true } }; },
    });
    await feed(impl, {
      jsonrpc: "2.0",
      id: 22,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "billing",
        threadId: "root-thread",
        mode: "url",
        message: "Sign in to continue",
        url: "https://billing.example/auth",
        elicitationId: "el-1",
      },
    });
    expect(seen).toEqual({
      mcpServerName: "billing",
      message: "Sign in to continue",
      mode: "url",
      url: "https://billing.example/auth",
      elicitationId: "el-1",
    });
    // Content goes back only with an accept.
    expect(replyTo(22)?.["result"]).toEqual({ action: "decline" });
  });

  it("cancels when the handler throws", async () => {
    const { impl, replyTo } = session({ onElicitation: async () => { throw new Error("boom"); } });
    await feed(impl, formElicitation(23));
    expect(replyTo(23)?.["result"]).toEqual({ action: "cancel" });
  });

  it("routes Codex's other kinds, such as a connector sign-in, as elicitations rather than tool permissions", async () => {
    let asked = false;
    const { impl, replyTo } = session({ onUserInputRequest: async () => { asked = true; return { allow: true }; } });
    await feed(impl, formElicitation(24, { _meta: { codex_approval_kind: "browser_auth" } }));
    expect(asked).toBe(false);
    expect(replyTo(24)?.["result"]).toEqual({ action: "decline" });
  });
});

describe("unhandled server requests", () => {
  it("answers with a JSON-RPC method-not-found error instead of an empty result", async () => {
    const { impl, replyTo } = session();
    await feed(impl, { jsonrpc: "2.0", id: 30, method: "item/tool/call", params: { threadId: "root-thread" } });
    const reply = replyTo(30);
    expect(reply).not.toHaveProperty("result");
    expect(reply?.["error"]).toEqual({ code: -32601, message: "agentex does not handle the item/tool/call request" });
  });
});
