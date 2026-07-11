import { describe, expect, it, vi } from "vitest";
import { createExecBackedSession } from "../../src/sessions/exec-backed.js";
import { cursorSessionCodec } from "../../src/providers/cursor/codec.js";
import type { ExecutionContext, ExecutionResult } from "../../src/types.js";

function result(sessionId: string, summary = "ok"): ExecutionResult {
  const now = new Date().toISOString();
  return {
    runId: "run", exitCode: 0, signal: null, status: "completed",
    startedAt: now, completedAt: now, durationMs: 1,
    errorMessage: null, errorCode: null, costUsd: null, model: "model",
    summary, sessionParams: { sessionId, cwd: "/tmp" },
    sessionDisplayId: sessionId, clearSession: false, billingType: "subscription",
  };
}

describe("createExecBackedSession", () => {
  it("promotes and resumes session parameters across turns", async () => {
    const execute = vi.fn(async (ctx: ExecutionContext) => {
      const sessionId = ctx.sessionParams?.["sessionId"] as string | undefined;
      await ctx.onEvent?.({
        type: "system", subtype: "init", model: "model", cwd: "/tmp", tools: null,
        permissionMode: null, timestamp: new Date().toISOString(), providerType: "cursor",
        sessionId: sessionId ?? "cursor-1", messageId: null, eventId: null,
        turnId: null, parentToolCallId: null, raw: {},
      });
      return result(sessionId ?? "cursor-1", ctx.prompt);
    });
    const session = createExecBackedSession({
      providerType: "cursor", execute, sessionCodec: cursorSessionCodec, ctx: { cwd: "/tmp" },
    });
    expect((await (await session.send("first")).result).summary).toBe("first");
    expect(session.sessionId).toBe("cursor-1");
    expect((await (await session.send("second")).result).summary).toBe("second");
    expect(execute.mock.calls[1]?.[0].sessionParams).toMatchObject({ sessionId: "cursor-1" });
    await session.close();
  });

  it("rejects overlapping sends and supports interrupt", async () => {
    let release!: () => void;
    const execute = vi.fn((ctx: ExecutionContext) => new Promise<ExecutionResult>((resolve) => {
      ctx.signal?.addEventListener("abort", () => resolve({ ...result("cursor-1"), status: "aborted" }));
      release = () => resolve(result("cursor-1"));
    }));
    const session = createExecBackedSession({
      providerType: "cursor", execute, sessionCodec: cursorSessionCodec, ctx: {},
    });
    const first = await session.send("first");
    await expect(session.send("overlap")).rejects.toThrow(/busy/);
    await session.interrupt();
    await expect(first.result).resolves.toMatchObject({ status: "aborted" });
    release();
  });
});
