import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../../../src/types.js";

const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../../../src/providers/opencode/server.js", () => ({
  acquireOpenCodeServer: mocks.acquire,
}));

import { createOpenCodeSession } from "../../../src/providers/opencode/http-session.js";

function openSse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
}

function fixture(options: {
  messageStatus?: number;
  current?: boolean;
  permissions?: Record<string, unknown>[];
  questions?: Record<string, unknown>[];
  failFirstReply?: boolean;
  messageDelayMs?: number;
} = {}) {
  const calls: Array<{ kind: string; path: string; init?: RequestInit }> = [];
  let replyAttempts = 0;
  let permissionResolved = false;
  const client = {
    async request(path: string, init?: RequestInit) {
      calls.push({ kind: "request", path, init });
      if (path === "/session") return Response.json({ id: "ses_test" });
      if (path === "/global/event") return openSse();
      if (path.includes("/message")) {
        if (options.messageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.messageDelayMs));
        if ((options.messageStatus ?? 200) !== 200) return new Response("sensitive upstream text", { status: options.messageStatus });
        return Response.json({
          info: {
            id: "msg_result", role: "assistant", providerID: "anthropic", modelID: "claude",
            finish: "stop", tokens: { input: 1, output: 2 }, cost: 0.01,
          },
          parts: [{ id: "part_text", messageID: "msg_result", sessionID: "ses_test", type: "text", text: "done" }],
        });
      }
      throw new Error(`unexpected request ${path}`);
    },
    async json(path: string) {
      calls.push({ kind: "json", path });
      if (path === "/permission") return permissionResolved ? [] : (options.permissions ?? []);
      if (path === "/question") return options.questions ?? [];
      throw new Error(`unexpected json ${path}`);
    },
    async ok(path: string, init?: RequestInit) {
      calls.push({ kind: "ok", path, init });
      if (path.includes("/permission/") || path.includes("/question/")) {
        replyAttempts += 1;
        if (options.failFirstReply && replyAttempts === 1) throw new Error("temporary reply failure");
        permissionResolved = true;
      }
    },
  };
  const handle = {
    client,
    generation: 0,
    release: vi.fn(),
    retire: vi.fn(),
    isCurrent: () => options.current ?? true,
  };
  return { handle, calls, get replyAttempts() { return replyAttempts; } };
}

describe("OpenCode HTTP session contract", () => {
  beforeEach(() => mocks.acquire.mockReset());

  it("sends model variant and agent and emits exactly one terminal result", async () => {
    const fake = fixture();
    mocks.acquire.mockResolvedValue(fake.handle);
    const events: StreamEvent[] = [];
    const session = await createOpenCodeSession({
      config: { model: "anthropic/claude", modelVariant: "high", modeId: "build" },
      onEvent: (event) => events.push(event),
    });
    const turn = await (await session.send("hello")).result;
    expect(turn).toMatchObject({ status: "completed", summary: "done" });
    const message = fake.calls.find((call) => call.kind === "request" && call.path.includes("/message"));
    expect(JSON.parse(String(message?.init?.body))).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude" },
      variant: "high",
      agent: "build",
    });
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    await session.close();
  });

  it("emits one terminal failure without exposing an upstream response body", async () => {
    const fake = fixture({ messageStatus: 500 });
    mocks.acquire.mockResolvedValue(fake.handle);
    const events: StreamEvent[] = [];
    const session = await createOpenCodeSession({ onEvent: (event) => events.push(event) });
    const turn = await (await session.send("hello")).result;
    expect(turn).toMatchObject({ status: "failed", errorCode: "http_error" });
    expect(turn.errorMessage).not.toContain("sensitive upstream text");
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    await session.close();
  });

  it("fails stale handles with runtime_reconfigured and one terminal result", async () => {
    const fake = fixture({ current: false });
    mocks.acquire.mockResolvedValue(fake.handle);
    const events: StreamEvent[] = [];
    const session = await createOpenCodeSession({ onEvent: (event) => events.push(event) });
    const turn = await (await session.send("hello")).result;
    expect(turn.errorCode).toBe("runtime_reconfigured");
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    expect(fake.calls.some((call) => call.path.includes("/message"))).toBe(false);
    await session.close();
  });

  it("retries a failed permission reply without asking the host twice", async () => {
    const permission = {
      id: "per_test", sessionID: "ses_test", permission: "bash",
      patterns: ["echo hi"], metadata: {}, always: [],
    };
    const fake = fixture({ permissions: [permission], failFirstReply: true, messageDelayMs: 900 });
    mocks.acquire.mockResolvedValue(fake.handle);
    const host = vi.fn(async () => ({ allow: true }));
    const session = await createOpenCodeSession({ onUserInputRequest: host });
    await (await session.send("hello")).result;
    expect(host).toHaveBeenCalledOnce();
    expect(fake.replyAttempts).toBe(2);
    const replies = fake.calls.filter((call) => call.kind === "ok" && call.path.includes("/permission/"));
    expect(replies.map((call) => JSON.parse(String(call.init?.body)).reply)).toEqual(["once", "once"]);
    expect(JSON.stringify(replies)).not.toContain("always");
    await session.close();
  });

  it("starts the input deadline only for an observed request and rejects safely", async () => {
    const permission = {
      id: "per_timeout", sessionID: "ses_test", permission: "write",
      patterns: ["file"], metadata: {}, always: [],
    };
    const fake = fixture({ permissions: [permission] });
    mocks.acquire.mockResolvedValue(fake.handle);
    const session = await createOpenCodeSession({
      config: { inputRequestTimeoutSec: 0.01, unattendedPermissionPolicy: "deny" },
      onUserInputRequest: () => new Promise(() => undefined),
    });
    const reply = fake.calls.find((call) => call.kind === "ok" && call.path.includes("/permission/"));
    expect(JSON.parse(String(reply?.init?.body)).reply).toBe("reject");
    await session.close();
  });
});
