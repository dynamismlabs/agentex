import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSessionImpl } from "../../src/providers/claude/session.js";
import { CodexSessionImpl } from "../../src/providers/codex/session.js";
import { getClaudeTranscriptPath } from "../../src/providers/claude/transcript.js";
import { parseClaudeStreamEvent } from "../../src/providers/claude/parse.js";
import { parseCodexStreamEvent } from "../../src/providers/codex/parse.js";

function fakeProcess(reply: (request: Record<string, any>) => Record<string, unknown> | null) {
  const writes: Record<string, any>[] = [];
  const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const stdin = Object.assign(new EventEmitter(), { write(chunk: string) {
    const request = JSON.parse(chunk); writes.push(request);
    const response = reply(request);
    if (response) queueMicrotask(() => stdout.emit("data", JSON.stringify(response) + "\n"));
    return true;
  }, end() {} });
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, { stdin, stdout, stderr, kill() { queueMicrotask(() => emitter.emit("exit", 0, null)); return true; } }) as unknown as ChildProcess;
  return { proc, writes };
}

describe("native session titles", () => {
  it("Claude generates a suggestion without persisting it or sending a user turn", async () => {
    const { proc, writes } = fakeProcess((request) => ({ type: "control_response", response: {
      request_id: request.request_id, subtype: "success", response: { title: "Native suggestion" },
    } }));
    const session = new ClaudeSessionImpl(proc, { cwd: tmpdir() }, null);
    expect(await session.generateNativeTitle("description")).toBe("Native suggestion");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.request).toEqual({ subtype: "generate_session_title", description: "description", persist: false });
    await session.setTitle("Manual name");
    expect(writes[1]?.request).toEqual({ subtype: "rename_session", title: "Manual name", source: "host" });
    await session.close();
  });

  it("Claude cancels and removes a pending native request", async () => {
    const { proc, writes } = fakeProcess(() => null);
    const session = new ClaudeSessionImpl(proc, { cwd: tmpdir() }, null);
    const controller = new AbortController();
    const title = session.generateNativeTitle("description", { signal: controller.signal });
    controller.abort();
    await expect(title).rejects.toMatchObject({ name: "AbortError" });
    expect(writes[1]?.type).toBe("control_cancel_request");
    expect((session as any)._pendingControlResponses.size).toBe(0);
    await session.close();
  });

  it("reads Claude's latest custom title ahead of its generated title", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentex-title-"));
    try {
      const { proc } = fakeProcess(() => null);
      const session = new ClaudeSessionImpl(proc, { cwd: root, env: { CLAUDE_CONFIG_DIR: root }, sessionParams: { sessionId: "title-test" } }, null);
      const { filePath } = await getClaudeTranscriptPath({ sessionId: "title-test", cwd: root, claudeHome: root });
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, [
        { type: "custom-title", customTitle: "Old name", sessionId: "title-test" },
        { type: "ai-title", aiTitle: "Generated name", sessionId: "title-test" },
        { type: "custom-title", customTitle: "Manual name", sessionId: "title-test" },
      ].map((entry) => JSON.stringify(entry) + "\n").join(""));
      expect(await session.readTitle()).toBe("Manual name");
      await session.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("Codex reads name rather than preview and renames through RPC", async () => {
    const { proc, writes } = fakeProcess((request) => ({ id: request.id, result:
      request.method === "thread/read" ? { thread: { name: "Native name", preview: "Entire first message" } } : {},
    }));
    const session = new CodexSessionImpl(proc, {}, tmpdir(), "model", null);
    (session as any)._threadId = "root-thread";
    expect(await session.readTitle()).toBe("Native name");
    await session.setTitle("Manual name");
    expect(writes[0]).toMatchObject({ method: "thread/read", params: { threadId: "root-thread", includeTurns: false } });
    expect(writes[1]).toMatchObject({ method: "thread/name/set", params: { threadId: "root-thread", name: "Manual name" } });
    expect((session as any).generateNativeTitle).toBeUndefined();
    await session.close();
  });

  it("normalizes native title notifications as metadata events", () => {
    expect(parseClaudeStreamEvent({ type: "system", subtype: "session_title_changed", title: "Claude name", session_id: "c1" }))
      .toMatchObject([{ type: "title_changed", title: "Claude name", sessionId: "c1" }]);
    expect(parseCodexStreamEvent({ method: "thread/name/updated", params: { threadId: "x1", threadName: "Codex name" } }))
      .toMatchObject([{ type: "title_changed", title: "Codex name", sessionId: "x1" }]);
  });

  it("Codex removes a pending title RPC immediately on cancellation", async () => {
    const { proc, writes } = fakeProcess(() => null);
    const session = new CodexSessionImpl(proc, {}, tmpdir(), "model", null);
    (session as any)._threadId = "root-thread";
    const controller = new AbortController();
    const title = session.readTitle({ signal: controller.signal });
    controller.abort();
    await expect(title).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toHaveLength(1);
    expect((session as any)._pendingRpc.size).toBe(0);
    await session.close();
  });
});
