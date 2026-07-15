import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import { parseAskUserQuestion } from "../../../src/index.js";
import { assertSessionRecord } from "../../../src/sessions/index.js";
import type {
  SessionContext,
  StreamEvent,
  TurnResult,
  UserInputRequest,
} from "../../../src/types.js";

function makeFakeProc(): { proc: ChildProcess; writes: string[] } {
  const writes: string[] = [];
  const stdin = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};

  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true });
  return { proc, writes };
}

/**
 * Drives a Codex session as if a turn were mid-flight. Bypasses `send()` so
 * tests don't depend on JSON-RPC handshake — exercise the notification
 * dispatch path directly.
 */
function makeDrivenSession(ctx: SessionContext): {
  session: CodexSessionImpl;
  feed: (line: string) => void;
  turnResult: Promise<TurnResult>;
  writes: string[];
} {
  const { proc, writes } = makeFakeProc();
  const session = new CodexSessionImpl(proc, ctx, "/tmp", "test-model", null);
  const turnResult = new Promise<TurnResult>((resolve, reject) => {
    const s = session as unknown as {
      _pendingResults: Array<{
        resolve: (r: TurnResult) => void;
        reject: (e: Error) => void;
      }>;
      _state: string;
    };
    s._pendingResults.push({ resolve, reject });
    s._state = "thinking";
    // Leave _turnStartedAt as null (the class default) so resolveTurn skips
    // the disk-scan branch and takes the sync deliverTurnResult path.
  });
  const feed = (line: string): void => {
    (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
  };
  return { session, feed, turnResult, writes };
}

function ndjson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("CodexSession — onEvent dispatch", () => {
  it("keeps child-agent notifications isolated from the root turn", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, turnResult } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    const internal = session as unknown as {
      _threadId: string | null;
      _state: string;
      _turnSummary: string | null;
    };
    internal._threadId = "root-thread";

    let settled = false;
    void turnResult.then(() => { settled = true; });

    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "child-thread", parentThreadId: "root-thread" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: { type: "commandExecution", id: "child-command", command: "sleep 1" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: {
          type: "agentMessage",
          id: "child-message",
          content: [{ type: "output_text", text: "child done" }],
          phase: "final_answer",
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: "child-thread", turnId: "child-turn", error: { message: "child error" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/failed",
      params: { threadId: "child-thread", turn: { id: "child-turn", status: "failed" }, message: "child failed" },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: {
          id: "child-turn",
          status: "completed",
          items: [{ type: "commandExecution", aggregatedOutput: "x".repeat(10_000) }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(session.sessionId).toBe("root-thread");
    expect(internal._state).toBe("thinking");
    expect(internal._turnSummary).toBeNull();
    expect(events.some((event) => event.sessionId === "child-thread")).toBe(false);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({
        type: "background_task",
        taskId: "child-thread",
        phase: "started",
        status: "running",
        sessionId: "root-thread",
      }),
      expect.objectContaining({
        type: "background_task",
        taskId: "child-thread",
        phase: "completed",
        status: "failed",
        summary: "child done",
        sessionId: "root-thread",
      }),
    ]);

    // Codex forwards the child's final answer to its parent as a later
    // `interacted` activity item. It must not resurrect the completed task.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "subAgentActivity",
          id: "late-interaction",
          kind: "interacted",
          agentThreadId: "child-thread",
          agentPath: "/root/child",
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "background_task")).toHaveLength(2);

    // Global notifications have no thread scope and must still flow through.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 25 } } },
    }));

    // Root commentary is observable progress but must not become the terminal
    // summary. The final_answer item supplies the root TurnResult summary.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: { type: "agentMessage", id: "root-commentary", text: "working", phase: "commentary" },
      },
    }));
    expect(internal._turnSummary).toBeNull();
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: { type: "agentMessage", id: "root-final", text: "root done", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } },
    }));

    const result = await turnResult;
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("root done");
    expect(events.some((event) => event.type === "rate_limit")).toBe(true);
    const assistants = events.filter((event) => event.type === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.type === "assistant" && assistants[0].phase).toBe("commentary");
    expect(assistants[1]?.type === "assistant" && assistants[1].phase).toBe("final_answer");
  });

  it("tracks a collab spawn past the root result and reconciles it with thread/read", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, turnResult, writes } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Run the lifecycle probe",
          agentsStates: {
            "child-thread": { status: "pendingInit", message: null },
          },
        },
      },
    }));

    const readRequest = writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((message) => message["method"] === "thread/read");
    expect(readRequest).toMatchObject({
      method: "thread/read",
      params: { threadId: "child-thread", includeTurns: true },
    });

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: { type: "agentMessage", id: "root-final", text: "ROOT_COMPLETE", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } },
    }));
    expect((await turnResult).summary).toBe("ROOT_COMPLETE");

    feed(ndjson({
      jsonrpc: "2.0",
      id: readRequest?.["id"],
      result: {
        thread: {
          id: "child-thread",
          parentThreadId: "root-thread",
          status: { type: "notLoaded" },
          turns: [{
            id: "child-turn",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", id: "child-input", content: [] },
              { type: "agentMessage", id: "child-final", text: "CHILD_COMPLETE", phase: "final_answer" },
            ],
          }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const background = events.filter((event) => event.type === "background_task");
    expect(background).toEqual([
      expect.objectContaining({
        taskId: "child-thread",
        phase: "started",
        status: "running",
        description: "Run the lifecycle probe",
      }),
      expect.objectContaining({
        taskId: "child-thread",
        phase: "completed",
        status: "completed",
        summary: "CHILD_COMPLETE",
        turnId: "child-turn",
      }),
    ]);
    const terminal = background[1];
    expect(terminal?.type === "background_task" ? terminal.raw : null).toEqual({
      method: "thread/read",
      reconciled: true,
      threadId: "child-thread",
      turnId: "child-turn",
      status: "completed",
      error: null,
    });
    expect(JSON.stringify(terminal?.raw).length).toBeLessThan(256);
    expect(events.findIndex((event) => event.type === "result"))
      .toBeLessThan(events.findIndex((event) => event.type === "background_task" && event.phase === "completed"));
  });

  it("emits one terminal edge when foreign completion races thread/read", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, writes } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Review",
          agentsStates: { "child-thread": { status: "running", message: null } },
        },
      },
    }));
    const readRequest = writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((message) => message["method"] === "thread/read");

    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "child-thread", parentThreadId: "root-thread" } },
    }));

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-final", text: "done", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: {
          id: "child-turn",
          status: "completed",
          items: [{ type: "commandExecution", aggregatedOutput: "x".repeat(10_000) }],
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      id: readRequest?.["id"],
      result: {
        thread: {
          id: "child-thread",
          status: { type: "notLoaded" },
          turns: [{
            id: "child-turn",
            status: "completed",
            error: null,
            items: [{ type: "agentMessage", id: "child-final", text: "done", phase: "final_answer" }],
          }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "background_task" && event.phase === "started"))
      .toHaveLength(1);
    expect(events.filter((event) => event.type === "background_task" && event.phase === "completed"))
      .toHaveLength(1);
    const terminal = events.find((event) => event.type === "background_task" && event.phase === "completed");
    expect(terminal?.raw).toEqual({
      method: "turn/completed",
      reconciled: false,
      threadId: "child-thread",
      turnId: "child-turn",
      status: "completed",
      error: null,
    });
    expect(JSON.stringify(terminal?.raw).length).toBeLessThan(256);
  });

  it("merges collab prompt metadata when thread/started wins the spawn race", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "child-thread", parentThreadId: "root-thread" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Inspect the provider lifecycle",
          agentsStates: { "child-thread": { status: "running", message: null } },
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-final", text: "done", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const background = events.filter((event) => event.type === "background_task");
    expect(background.filter((event) => event.type === "background_task" && event.phase === "started"))
      .toHaveLength(1);
    expect(background).toEqual([
      expect.objectContaining({ taskId: "child-thread", phase: "started" }),
      expect.objectContaining({
        taskId: "child-thread",
        phase: "progress",
        description: "Inspect the provider lifecycle",
      }),
      expect.objectContaining({
        taskId: "child-thread",
        phase: "completed",
        description: "Inspect the provider lifecycle",
      }),
    ]);
  });

  it("reconciles a reactivated child only against its authoritative foreign turn id", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, writes } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "First task",
          agentsStates: { "child-thread": { status: "completed", message: "FIRST_COMPLETE" } },
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-thread", turn: { id: "child-turn-2" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const readRequests = writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message["method"] === "thread/read");
    expect(readRequests).toHaveLength(1);
    feed(ndjson({
      jsonrpc: "2.0",
      id: readRequests[0]?.["id"],
      result: {
        thread: {
          id: "child-thread",
          status: { type: "notLoaded" },
          turns: [{
            id: "child-turn-1",
            status: "completed",
            error: null,
            items: [{ type: "agentMessage", id: "first-final", text: "FIRST_COMPLETE", phase: "final_answer" }],
          }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "background_task" && event.phase === "completed"))
      .toHaveLength(1);
    const internal = session as unknown as {
      _backgroundTaskPollTimers: Map<string, { timer: ReturnType<typeof setTimeout>; resolve: () => void }>;
    };
    for (const [key, pending] of internal._backgroundTaskPollTimers) {
      clearTimeout(pending.timer);
      internal._backgroundTaskPollTimers.delete(key);
      pending.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retriedReads = writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message["method"] === "thread/read");
    expect(retriedReads).toHaveLength(2);
    feed(ndjson({
      jsonrpc: "2.0",
      id: retriedReads[1]?.["id"],
      result: {
        thread: {
          id: "child-thread",
          status: { type: "notLoaded" },
          turns: [
            {
              id: "child-turn-1",
              status: "completed",
              error: null,
              items: [{ type: "agentMessage", id: "first-final", text: "FIRST_COMPLETE", phase: "final_answer" }],
            },
            {
              id: "child-turn-2",
              status: "completed",
              error: null,
              items: [{ type: "agentMessage", id: "second-final", text: "SECOND_COMPLETE", phase: "final_answer" }],
            },
          ],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const background = events.filter((event) => event.type === "background_task");
    expect(background.map((event) => event.type === "background_task" ? event.phase : null))
      .toEqual(["started", "completed", "progress", "completed"]);
    expect(background.filter((event) => event.type === "background_task" && event.phase === "completed"))
      .toEqual([
        expect.objectContaining({ summary: "FIRST_COMPLETE" }),
        expect.objectContaining({ summary: "SECOND_COMPLETE", turnId: "child-turn-2" }),
      ]);
  });

  it("maps a successful closeAgent with no agentsStates to stopped", async () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Long task",
          agentsStates: {},
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "close-call",
          tool: "closeAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: null,
          agentsStates: {},
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({ taskId: "child-thread", phase: "started", status: "running" }),
      expect.objectContaining({ taskId: "child-thread", phase: "completed", status: "stopped" }),
    ]);
  });

  it("closes active children and clears reconciliation state", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, turnResult } = makeDrivenSession({
      config: { graceSec: 0 },
      onEvent: (event) => { events.push(event); },
    });
    void turnResult.catch(() => {});
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-call",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Long task",
          agentsStates: {},
        },
      },
    }));
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({ taskId: "child-thread", phase: "started", status: "running" }),
      expect.objectContaining({
        taskId: "child-thread",
        phase: "completed",
        status: "stopped",
        summary: "Codex session closed",
      }),
    ]);
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "late-root-turn",
        item: {
          type: "collabAgentToolCall",
          id: "late-resume",
          tool: "resumeAgent",
          status: "completed",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Too late",
          agentsStates: {},
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-thread", turn: { id: "late-child-turn" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "background_task")).toHaveLength(2);
    const internal = session as unknown as {
      _pendingRpc: Map<number, unknown>;
      _backgroundTaskPollers: Map<string, unknown>;
      _backgroundTaskPollTimers: Map<string, unknown>;
    };
    expect(internal._pendingRpc.size).toBe(0);
    expect(internal._backgroundTaskPollers.size).toBe(0);
    expect(internal._backgroundTaskPollTimers.size).toBe(0);
  });

  it("removes an ignored bounded thread/read request from the pending map", async () => {
    const { session } = makeDrivenSession({});
    const internal = session as unknown as {
      boundedRpcRequest: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
      _pendingRpc: Map<number, unknown>;
    };

    const request = internal.boundedRpcRequest("thread/read", {
      threadId: "missing-child",
      includeTurns: true,
    }, 5);
    expect(internal._pendingRpc.size).toBe(1);
    await expect(request).rejects.toThrow("thread/read timed out");
    expect(internal._pendingRpc.size).toBe(0);
  });

  it("tracks fast and nested child threads without settling the root handle", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, turnResult } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";
    let rootSettled = false;
    void turnResult.then(() => { rootSettled = true; });

    // thread/started is the fallback source when a fast child can finish
    // before its root subAgentActivity item is published.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "root-thread",
          source: {
            subAgent: {
              thread_spawn: { parent_thread_id: "root-thread", agent_path: "/root/child" },
            },
          },
        },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "nested-thread", parentThreadId: "child-thread" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "nested-thread",
        turnId: "nested-turn",
        item: { type: "agentMessage", id: "nested-final", text: "nested done", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "nested-thread",
        turn: { id: "nested-turn", status: "completed" },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rootSettled).toBe(false);
    expect(events.filter((event) => event.type === "result")).toHaveLength(0);
    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({
        taskId: "child-thread",
        phase: "started",
        status: "running",
        description: "/root/child",
        parentTaskId: null,
      }),
      expect.objectContaining({
        taskId: "nested-thread",
        phase: "started",
        status: "running",
        parentTaskId: "child-thread",
      }),
      expect.objectContaining({
        taskId: "nested-thread",
        phase: "completed",
        status: "completed",
        summary: "nested done",
        parentTaskId: "child-thread",
      }),
    ]);
  });

  it("continues delivering child lifecycle after the root turn has settled", async () => {
    const events: StreamEvent[] = [];
    const { session, feed, turnResult } = makeDrivenSession({
      onEvent: (event) => { events.push(event); },
    });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "child-thread", parentThreadId: "root-thread" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } },
    }));
    await expect(turnResult).resolves.toMatchObject({ status: "completed" });

    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-final", text: "late child result", phase: "final_answer" },
      },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "completed" },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({ taskId: "child-thread", phase: "started", status: "running" }),
      expect.objectContaining({
        taskId: "child-thread",
        phase: "completed",
        status: "completed",
        summary: "late child result",
      }),
    ]);
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
  });

  it("does not let a foreign legacy thread.started replace the root id", () => {
    const events: StreamEvent[] = [];
    const { session, feed } = makeDrivenSession({ onEvent: (event) => { events.push(event); } });
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    feed(ndjson({ type: "thread.started", thread_id: "child-thread" }));

    expect(session.sessionId).toBe("root-thread");
    expect(events).toHaveLength(0);
  });

  it("forwards a synthesized result event on turn.completed before resolving", async () => {
    const events: StreamEvent[] = [];
    let resolvedAt = -1;
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    // Accumulate a summary via item.completed (legacy NDJSON shape).
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "final answer" },
    }));

    feed(ndjson({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "test-model",
    }));

    const tr = await turnResult;
    resolvedAt = events.length;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("final answer");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    if (resultEvents[0]?.type === "result") {
      expect(resultEvents[0].text).toBe("final answer");
      expect(resultEvents[0].isError).toBe(false);
    }
    // Result event was queued before TurnResult resolved.
    expect(resolvedAt).toBeGreaterThan(0);
  });

  it("forwards a result event on turn.failed with isError=true", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => { events.push(e); },
    });

    feed(ndjson({
      type: "turn.failed",
      message: "model unavailable",
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("failed");
    expect(tr.errorMessage).toBe("model unavailable");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    if (resultEvents[0]?.type === "result") {
      expect(resultEvents[0].isError).toBe(true);
    }
  });

  it("treats a v2 turn/completed with status 'failed' as an error (not a false completion)", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "x", status: "failed", error: { message: "Unsupported service_tier: flex" }, durationMs: 8153 } },
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("failed");
    expect(tr.errorCode).toBe("execution_error");
    expect(tr.errorMessage).toContain("Unsupported service_tier");

    const result = events.find((e) => e.type === "result");
    expect(result?.type === "result" && result.isError).toBe(true);
    expect(result?.type === "result" && result.terminalReason).toBe("failed");
  });

  it("captures a v2 `error` notification message into the failed turn (without resolving early)", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    // error notification arrives first; it must NOT resolve the turn.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "error",
      params: { error: { message: "boom 400", codexErrorInfo: "other" }, willRetry: false, threadId: "t", turnId: "u" },
    }));
    expect(events.filter((e) => e.type === "result")).toHaveLength(0);

    // turn/completed (status failed, no message of its own) resolves the turn,
    // surfacing the message captured from the error notification.
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "t", turn: { status: "failed", error: {} } },
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("failed");
    expect(tr.errorMessage).toBe("boom 400");
  });

  it("captures TurnResult.summary from a v2 `agentMessage` item (camelCase)", async () => {
    const { feed, turnResult } = makeDrivenSession({});
    feed(ndjson({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "pong" } },
    }));
    feed(ndjson({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "t", turn: { status: "completed" } },
    }));

    const tr = await turnResult;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("pong");
  });

  it("a handler that throws does not block subsequent handlers", async () => {
    const seen: string[] = [];
    const { feed, turnResult } = makeDrivenSession({
      onEvent: (e) => {
        // Throw on the assistant item; subsequent events must still arrive.
        if (e.type === "assistant" && e.text === "B") throw new Error("boom");
        if (e.type === "assistant") seen.push(`assistant:${e.text}`);
        else seen.push(e.type);
      },
    });

    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "A" },
    }));
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "B" },
    }));
    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "C" },
    }));
    feed(ndjson({ type: "turn.completed" }));

    await turnResult;
    expect(seen).toContain("assistant:A");
    expect(seen).not.toContain("assistant:B");
    expect(seen).toContain("assistant:C");
    expect(seen).toContain("result");
  });

  it("awaits async handlers in order before resolving TurnResult", async () => {
    const order: string[] = [];
    let resolveSlow: (() => void) | null = null;
    const slowDone = new Promise<void>((r) => { resolveSlow = r; });

    const { feed, turnResult } = makeDrivenSession({
      onEvent: async (e) => {
        if (e.type === "assistant") {
          await slowDone;
          order.push("slow-handler-done");
        } else if (e.type === "result") {
          order.push("result-handler-done");
        }
      },
    });

    feed(ndjson({
      type: "item.completed",
      item: { type: "agent_message", text: "slow" },
    }));
    feed(ndjson({ type: "turn.completed" }));

    let turnResolved = false;
    void turnResult.then(() => { turnResolved = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(turnResolved).toBe(false);

    resolveSlow!();
    await turnResult;
    expect(order).toEqual(["slow-handler-done", "result-handler-done"]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent send + cancel — Codex JSON-RPC has no per-message cancel.
// ---------------------------------------------------------------------------

describe("CodexSession — concurrent send", () => {
  it("send() while a turn is in progress no longer throws", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const h1 = await session.send("first");
    expect(h1.uuid).toBeTruthy();
    const h2 = await session.send("second mid-turn");
    expect(h2.uuid).toBeTruthy();
    expect(h2.uuid).not.toBe(h1.uuid);
  });

  it("multiple pending sends share the TurnResult when one turn.completed fires", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const h1 = await session.send("a");
    const h2 = await session.send("b");
    const h3 = await session.send("c");

    // One turn.completed drains every pending resolver with the same result.
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      ndjson({
        type: "item.completed",
        item: { type: "agent_message", text: "shared" },
      }),
    );
    (session as unknown as { handleLine: (l: string) => void }).handleLine(
      ndjson({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    );

    const [r1, r2, r3] = await Promise.all([h1.result, h2.result, h3.result]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1.summary).toBe("shared");
  });

  it("keeps every pending root send open when a child turn completes", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    (session as unknown as { _threadId: string | null })._threadId = "root-thread";

    const h1 = await session.send("a");
    const h2 = await session.send("b");
    let settled = 0;
    void h1.result.then(() => { settled += 1; });
    void h2.result.then(() => { settled += 1; });

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(0);

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: { type: "agentMessage", id: "root-final", text: "shared root result", phase: "final_answer" },
      },
    });
    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "completed" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

    const [r1, r2] = await Promise.all([h1.result, h2.result]);
    expect(r1).toBe(r2);
    expect(r1.summary).toBe("shared root result");
  });

  it("per-turn accumulators reset between sequential turns", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    const feed = (line: string): void => {
      (session as unknown as { handleLine: (l: string) => void }).handleLine(line);
    };

    const h1 = await session.send("turn-1");
    feed(ndjson({ type: "item.completed", item: { type: "agent_message", text: "first" } }));
    feed(ndjson({ type: "turn.completed" }));
    const r1 = await h1.result;
    expect(r1.summary).toBe("first");

    // Second turn must NOT inherit the first turn's summary.
    const h2 = await session.send("turn-2");
    feed(ndjson({ type: "turn.completed" }));
    const r2 = await h2.result;
    expect(r2.summary).toBeNull();
  });
});

describe("CodexSession — cancel", () => {
  it("returns {cancelled: false} — Codex has no per-message cancel", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    expect(await session.cancel("any-uuid")).toEqual({ cancelled: false });
  });
});

// ---------------------------------------------------------------------------
// Per-send timeout / abort (SendOptions)
// ---------------------------------------------------------------------------

function feedCodex(session: CodexSessionImpl, obj: Record<string, unknown>): void {
  (session as unknown as { handleLine: (l: string) => void }).handleLine(JSON.stringify(obj));
}

describe("CodexSession — per-send timeout / abort", () => {
  it("resolves status 'timeout' when the deadline fires", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const handle = await session.send("slow", { timeoutSec: 0.02 });
    const tr = await handle.result;
    expect(tr.status).toBe("timeout");
    expect(tr.errorCode).toBe("timeout");
  });

  it("falls back to ProviderConfig.timeoutSec as the session-level default", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, { config: { timeoutSec: 0.02 } }, "/tmp", "test-model", null);

    const handle = await session.send("task");
    const tr = await handle.result;
    expect(tr.status).toBe("timeout");
  });

  it("a real result before the timeout wins", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const handle = await session.send("task", { timeoutSec: 100 });
    feedCodex(session, { type: "item.completed", item: { type: "agent_message", text: "done" } });
    // Usage present → sync delivery (no disk-scan branch).
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

    const tr = await handle.result;
    expect(tr.status).toBe("completed");
    expect(tr.summary).toBe("done");
  });

  it("SendOptions.signal abort resolves status 'aborted'", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);

    const ac = new AbortController();
    const handle = await session.send("task", { signal: ac.signal });
    ac.abort();

    const tr = await handle.result;
    expect(tr.status).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

describe("CodexSession — drain", () => {
  it("refuses new sends while draining, awaits the in-flight turn, then closes", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, { config: { graceSec: 0.02 } }, "/tmp", "test-model", null);

    const handle = await session.send("task");
    const drainP = session.drain();

    await expect(session.send("nope")).rejects.toThrow(/draining/);

    // Usage present → sync delivery, no disk scan.
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    const tr = await handle.result;
    expect(tr.status).toBe("completed");

    await drainP;
    expect(session.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// tool_result.toolName (Codex sets it directly in the parser)
// ---------------------------------------------------------------------------

describe("CodexSession — tool_result.toolName", () => {
  it("emits tool_result.toolName for command_execution items", async () => {
    const events: StreamEvent[] = [];
    const { feed, turnResult } = makeDrivenSession({ onEvent: (e) => { events.push(e); } });

    feed(ndjson({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "ls" } }));
    feed(ndjson({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", aggregated_output: "files", exit_code: 0 },
    }));
    feed(ndjson({ type: "turn.completed" }));

    await turnResult;
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type === "tool_result" && tr.toolName).toBe("command_execution");
  });
});

// ---------------------------------------------------------------------------
// Handshake — thread/start (fresh) vs thread/resume (continue a session)
// ---------------------------------------------------------------------------

/** A JSON-RPC error to return from a makeRpcProc handler. */
class RpcError {
  constructor(
    public readonly code: number,
    public readonly rpcMessage: string,
  ) {}
}

/**
 * Fake child process that auto-responds to outgoing JSON-RPC *requests* using a
 * per-method handler map, and records every message the session writes to
 * stdin. A handler returning an RpcError yields a JSON-RPC error response.
 */
function makeRpcProc(
  handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>,
): {
  proc: ChildProcess;
  writes: Array<Record<string, unknown>>;
} {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const writes: Array<Record<string, unknown>> = [];

  const stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        writes.push(msg);
        if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
          const id = msg["id"] as number;
          const handler = handlers[msg["method"] as string];
          const out = handler ? handler((msg["params"] as Record<string, unknown>) ?? {}) : {};
          void Promise.resolve(out).then((resolved) => {
            const response =
              resolved instanceof RpcError
                ? { jsonrpc: "2.0", id, error: { code: resolved.code, message: resolved.rpcMessage } }
                : { jsonrpc: "2.0", id, result: resolved };
            stdout.emit("data", JSON.stringify(response) + "\n");
          });
        }
      }
      return true;
    },
    end: () => {},
  };

  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true });
  return { proc, writes };
}

function methodsWritten(writes: Array<Record<string, unknown>>): string[] {
  return writes.map((w) => w["method"]).filter((m): m is string => typeof m === "string");
}

function paramsFor(writes: Array<Record<string, unknown>>, method: string): Record<string, unknown> {
  const msg = writes.find((w) => w["method"] === method);
  return (msg?.["params"] as Record<string, unknown>) ?? {};
}

function writesFor(
  writes: Array<Record<string, unknown>>,
  method: string,
): Array<Record<string, unknown>> {
  return writes.filter((write) => write["method"] === method);
}

describe("CodexSession — interrupt", () => {
  it("targets the active root turn and maps interrupted completion to aborted", async () => {
    const events: StreamEvent[] = [];
    let turnNumber = 0;
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => ({
        turn: { id: `root-turn-${++turnNumber}`, status: "inProgress" },
      }),
      "turn/interrupt": () => ({}),
    });
    const session = new CodexSessionImpl(
      proc,
      { onEvent: (event) => { events.push(event); } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const first = await session.send("Stop this turn");
    await session.interrupt();

    expect(writesFor(writes, "turn/interrupt")).toHaveLength(1);
    expect(paramsFor(writes, "turn/interrupt")).toEqual({
      threadId: "root-thread",
      turnId: "root-turn-1",
    });
    expect(methodsWritten(writes)).not.toContain("turn/cancel");

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn-1", status: "interrupted" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

    await expect(first.result).resolves.toMatchObject({
      status: "aborted",
      errorCode: "aborted",
      errorMessage: "Turn was interrupted",
    });
    expect(events.find((event) => event.type === "result")).toMatchObject({
      type: "result",
      isError: false,
      terminalReason: "interrupted",
    });

    const second = await session.send("Stop the next turn too");
    await session.interrupt();
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(2);
    expect(writesFor(writes, "turn/interrupt")[1]?.["params"]).toEqual({
      threadId: "root-thread",
      turnId: "root-turn-2",
    });

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn-2", status: "interrupted" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await expect(second.result).resolves.toMatchObject({ status: "aborted" });
  });

  it("waits for the root turn id and coalesces repeated interrupt calls", async () => {
    let resolveTurnStart!: (value: unknown) => void;
    const delayedTurnStart = new Promise<unknown>((resolve) => {
      resolveTurnStart = resolve;
    });
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => delayedTurnStart,
      "turn/interrupt": () => ({}),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const handle = await session.send("Interrupt immediately");
    const firstInterrupt = session.interrupt();
    const secondInterrupt = session.interrupt();
    await Promise.resolve();
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(0);

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "inProgress" },
      },
    });
    await Promise.resolve();
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(0);

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "inProgress" },
      },
    });
    resolveTurnStart({ turn: { id: "late-response-turn", status: "inProgress" } });
    await Promise.all([firstInterrupt, secondInterrupt]);
    await session.interrupt();

    expect(writesFor(writes, "turn/interrupt")).toHaveLength(1);
    expect(paramsFor(writes, "turn/interrupt")).toEqual({
      threadId: "root-thread",
      turnId: "root-turn",
    });

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "interrupted" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await handle.result;
  });

  it("releases an interrupt waiting for an id as soon as the turn terminates", async () => {
    let resolveTurnStart!: (value: unknown) => void;
    const delayedTurnStart = new Promise<unknown>((resolve) => {
      resolveTurnStart = resolve;
    });
    let releaseResultEvent!: () => void;
    const resultEventGate = new Promise<void>((resolve) => {
      releaseResultEvent = resolve;
    });
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => delayedTurnStart,
    });
    const session = new CodexSessionImpl(
      proc,
      {
        onEvent: async (event) => {
          if (event.type === "result") await resultEventGate;
        },
      },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const handle = await session.send("Finish before the turn id arrives");
    let resultSettled = false;
    void handle.result.then(() => { resultSettled = true; });
    const interrupt = session.interrupt();

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "completed" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    resolveTurnStart({ turn: { id: "late-turn", status: "completed" } });

    await interrupt;
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(0);
    expect(resultSettled).toBe(false);

    releaseResultEvent();
    await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  });

  it("falls back to turn/started when the turn/start response omits the id", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => ({}),
      "turn/interrupt": () => ({}),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const handle = await session.send("Use the lifecycle notification");
    const interrupt = session.interrupt();
    await Promise.resolve();
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(0);

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "root-thread",
        turn: { id: "notification-turn", status: "inProgress" },
      },
    });
    await interrupt;

    expect(paramsFor(writes, "turn/interrupt")).toEqual({
      threadId: "root-thread",
      turnId: "notification-turn",
    });

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "notification-turn", status: "interrupted" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await handle.result;
  });

  it("keeps the leader turn id when concurrent sends return different ids", async () => {
    let turnNumber = 0;
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => ({
        turn: { id: ++turnNumber === 1 ? "leader-turn" : "queued-turn", status: "inProgress" },
      }),
      "turn/interrupt": () => ({}),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const [leader, queued] = await Promise.all([
      session.send("Leader"),
      session.send("Queued"),
    ]);
    await session.interrupt();

    expect(paramsFor(writes, "turn/interrupt")).toEqual({
      threadId: "root-thread",
      turnId: "leader-turn",
    });

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "leader-turn", status: "interrupted" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const [leaderResult, queuedResult] = await Promise.all([leader.result, queued.result]);
    expect(leaderResult).toBe(queuedResult);
    expect(leaderResult.status).toBe("aborted");
  });

  it("propagates turn/interrupt RPC failures to the caller", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "root-thread" } }),
      "turn/start": () => ({ turn: { id: "root-turn", status: "inProgress" } }),
      "turn/interrupt": () => new RpcError(-32600, "Invalid request"),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const handle = await session.send("This interrupt will fail");
    await expect(session.interrupt()).rejects.toThrow("JSON-RPC error -32600: Invalid request");
    expect(writesFor(writes, "turn/interrupt")).toHaveLength(1);

    feedCodex(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "completed" },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await handle.result;
  });
});

describe("CodexSession — turn selection overrides", () => {
  it("forwards ProviderConfig model and effort to turn/start", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_effort" } }),
      "turn/start": () => ({ turn: { id: "turn_effort", status: "inProgress" } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { config: { effort: "xhigh" } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const handle = await session.send("Solve carefully");
    expect(paramsFor(writes, "turn/start")["model"]).toBe("test-model");
    expect(paramsFor(writes, "turn/start")["effort"]).toBe("xhigh");

    (session as unknown as { handleLine: (line: string) => void }).handleLine(
      ndjson({ type: "turn.completed" }),
    );
    await handle.result;
  });

  it("omits effort when the provider config does not override it", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_default_effort" } }),
      "turn/start": () => ({ turn: { id: "turn_default_effort", status: "inProgress" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const handle = await session.send("Use the configured default");
    expect(paramsFor(writes, "turn/start")["model"]).toBe("test-model");
    expect(paramsFor(writes, "turn/start")["effort"]).toBeUndefined();

    (session as unknown as { handleLine: (line: string) => void }).handleLine(
      ndjson({ type: "turn.completed" }),
    );
    await handle.result;
  });

  it("applies model and effort overrides after resuming an existing thread", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
      "thread/goal/get": () => ({ goal: {} }),
      "turn/start": () => ({ turn: { id: "turn_resumed_selection", status: "inProgress" } }),
    });
    const session = new CodexSessionImpl(
      proc,
      {
        sessionParams: { sessionId: "thr_existing" },
        config: { model: "gpt-5.4", effort: "high" },
      },
      "/tmp",
      "gpt-5.4",
      null,
    );
    await session.handshake();

    const handle = await session.send("Continue with the new selection");
    expect(paramsFor(writes, "turn/start")).toMatchObject({
      threadId: "thr_existing",
      model: "gpt-5.4",
      effort: "high",
    });

    (session as unknown as { handleLine: (line: string) => void }).handleLine(
      ndjson({ type: "turn.completed" }),
    );
    await handle.result;
  });
});

describe("CodexSession — handshake resume", () => {
  it("starts a fresh thread (thread/start) when no sessionParams are given", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_fresh" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/start");
    expect(methods).not.toContain("thread/resume");
    expect(session.sessionId).toBe("thr_fresh");
  });

  it("declares the experimentalApi capability so goal methods are reachable", async () => {
    // codex 0.130.0 rejects thread/goal/{set,get,clear} with "requires
    // experimentalApi capability" unless this is declared in initialize.
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_x" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", "test-model", null);
    await session.handshake();
    const caps = paramsFor(writes, "initialize")["capabilities"] as Record<string, unknown>;
    expect(caps?.["experimentalApi"]).toBe(true);
  });

  it("resumes an existing thread (thread/resume) when sessionParams carry a sessionId", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
      "thread/start": () => ({ thread: { id: "thr_should_not_be_used" } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_existing" } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(session.sessionId).toBe("thr_existing");
    expect(paramsFor(writes, "thread/resume")["threadId"]).toBe("thr_existing");
  });

  it("hydrates a durable Codex goal on resume via thread/goal/get", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
      "thread/goal/get": () => ({ goal: { objective: "ship it", status: "active", tokensUsed: 5, timeUsedSeconds: 2 } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_existing" } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();
    expect(methodsWritten(writes)).toContain("thread/goal/get");
    expect(session.getGoal()).toMatchObject({ objective: "ship it", status: "active", tokensUsed: 5, timeUsedSeconds: 2 });
  });

  it("leaves getGoal() null on resume when there is no active goal (or goals are off)", async () => {
    const { proc } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
      "thread/goal/get": () => ({ goal: {} }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_existing" } },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();
    expect(session.getGoal()).toBeNull();
  });

  it("recovers the resume id from the thread_id alias", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": (params) => ({ thread: { id: params["threadId"] } }),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { thread_id: "thr_alias" } },
      "/tmp",
      null,
      null,
    );
    await session.handshake();
    expect(methodsWritten(writes)).toContain("thread/resume");
    expect(session.sessionId).toBe("thr_alias");
  });

  it("passes developerInstructions on resume and falls back to the resumed id when the response is empty", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": () => ({}),
    });
    const session = new CodexSessionImpl(
      proc,
      { sessionParams: { sessionId: "thr_x" } },
      "/tmp",
      null,
      "Be concise.",
    );
    await session.handshake();
    expect(paramsFor(writes, "thread/resume")["developerInstructions"]).toBe("Be concise.");
    expect(session.sessionId).toBe("thr_x");
  });

  it("falls back to a fresh thread (with a stderr notice) when resume is rejected", async () => {
    const stderr: string[] = [];
    const events: StreamEvent[] = [];
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/resume": () => new RpcError(-32000, "unknown thread"),
      "thread/start": () => {
        const stdout = (proc as unknown as { stdout: EventEmitter }).stdout;
        // Real app-server can publish thread/started before returning the
        // thread/start RPC response. Exercise that ordering after fallback.
        queueMicrotask(() => stdout.emit("data", ndjson({
          jsonrpc: "2.0",
          method: "thread/started",
          params: { thread: { id: "thr_new", cwd: "/tmp" } },
        }) + "\n"));
        return { thread: { id: "thr_new" } };
      },
    });
    const session = new CodexSessionImpl(
      proc,
      {
        sessionParams: { sessionId: "thr_gone" },
        onOutput: (stream, chunk) => {
          if (stream === "stderr") stderr.push(chunk);
        },
        onEvent: (event) => { events.push(event); },
      },
      "/tmp",
      "test-model",
      null,
    );
    await session.handshake();

    const methods = methodsWritten(writes);
    expect(methods).toContain("thread/resume");
    expect(methods).toContain("thread/start"); // fell back to a fresh thread
    expect(session.sessionId).toBe("thr_new");
    expect(stderr.join("")).toMatch(/thread\/resume failed/);
    expect(events.some((event) =>
      event.type === "system" && event.subtype === "init" && event.sessionId === "thr_new"
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Permission requests (server→client): command/file approval + requestUserInput
// ---------------------------------------------------------------------------

/** Emit a server→client JSON-RPC request to the session and return the result
 *  the session writes back (its `rpcResponse`). */
async function emitServerRequest(
  proc: ChildProcess,
  writes: Array<Record<string, unknown>>,
  request: { id: number; method: string; params: Record<string, unknown> },
): Promise<Record<string, unknown> | undefined> {
  const stdout = (proc as unknown as { stdout: EventEmitter }).stdout;
  stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
  // Let the async onUserInputRequest + rpcResponse settle.
  await new Promise((r) => setTimeout(r, 10));
  const resp = writes.find((w) => w["id"] === request.id && "result" in w);
  return resp?.["result"] as Record<string, unknown> | undefined;
}

describe("CodexSession — permission requests", () => {
  it("responds { decision: 'accept' } to a command approval the host allows", async () => {
    const { proc, writes } = makeRpcProc({});
    const seen: string[] = [];
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async (req) => { seen.push(req.toolName); return { allow: true }; } },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { id: "item_1", command: "rm -rf /tmp/x" },
    });
    expect(result).toEqual({ decision: "accept" });
    expect(seen).toEqual(["command_execution"]);
  });

  it("responds { decision: 'decline' } when the host denies a file change", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: false, message: "no" }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 101,
      method: "item/fileChange/requestApproval",
      params: { id: "item_2", path: "/etc/hosts" },
    });
    expect(result).toEqual({ decision: "decline" });
  });

  it("auto-accepts (decision: 'accept') when no host handler is registered", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(proc, {}, "/tmp", "m", null);
    const result = await emitServerRequest(proc, writes, {
      id: 102,
      method: "item/commandExecution/requestApproval",
      params: { id: "item_3", command: "ls" },
    });
    expect(result).toEqual({ decision: "accept" });
  });

  it("maps requestUserInput to AskUserQuestion and answers by question id", async () => {
    const { proc, writes } = makeRpcProc({});
    const calls: UserInputRequest[] = [];
    new CodexSessionImpl(
      proc,
      {
        onUserInputRequest: async (req) => {
          calls.push(req);
          // Host answers keyed by question text (agentex AskUserQuestion convention).
          return { allow: true, updatedInput: { answers: { "Pick a framework": "Hono" } } };
        },
      },
      "/tmp",
      "m",
      null,
    );

    const result = await emitServerRequest(proc, writes, {
      id: 103,
      method: "item/tool/requestUserInput",
      params: {
        id: "q_call_1",
        questions: [
          {
            id: "framework",
            header: "Framework",
            question: "Pick a framework",
            options: [{ label: "Express" }, { label: "Hono" }],
          },
        ],
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("AskUserQuestion");
    // The mapped request is parseAskUserQuestion-compatible.
    const parsed = parseAskUserQuestion(calls[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.question).toBe("Pick a framework");
    expect(parsed![0]!.options.map((o) => o.label)).toEqual(["Express", "Hono"]);
    expect(result).toEqual({ answers: { framework: { answers: ["Hono"] } } });
  });

  it("handles the legacy tool/requestUserInput method and multi-select answers", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: true, updatedInput: { answers: { "Q?": ["a", "b"] } } }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 104,
      method: "tool/requestUserInput",
      params: {
        id: "c",
        questions: [{ id: "x", header: "H", question: "Q?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] }],
      },
    });
    expect(result).toEqual({ answers: { x: { answers: ["a", "b"] } } });
  });

  it("uses waiting_for_input state for questions and restores to idle (not thinking) with no active turn", async () => {
    const { proc, writes } = makeRpcProc({});
    const holder: { session?: CodexSessionImpl } = {};
    const states: string[] = [];
    holder.session = new CodexSessionImpl(
      proc,
      {
        onUserInputRequest: async () => {
          states.push(holder.session!.state);
          return { allow: true, updatedInput: { answers: { "Q?": "a" } } };
        },
      },
      "/tmp",
      "m",
      null,
    );
    await emitServerRequest(proc, writes, {
      id: 200,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "x", header: "H", question: "Q?", options: [{ label: "a" }] }] },
    });
    expect(states).toEqual(["waiting_for_input"]);
    // No turn was in flight, so the state must restore to idle — never clobbered to "thinking".
    expect(holder.session.state).toBe("idle");
  });

  it("answers a header-only question (no `question` text)", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: true, updatedInput: { answers: { Branch: "main" } } }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 201,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "branch", header: "Branch", options: [{ label: "main" }] }] },
    });
    // The header is used as the prompt text, so the host's answer (keyed by it) lands.
    expect(result).toEqual({ answers: { branch: { answers: ["main"] } } });
  });

  it("returns empty answers when the host declines a requestUserInput", async () => {
    const { proc, writes } = makeRpcProc({});
    new CodexSessionImpl(
      proc,
      { onUserInputRequest: async () => ({ allow: false }) },
      "/tmp",
      "m",
      null,
    );
    const result = await emitServerRequest(proc, writes, {
      id: 105,
      method: "item/tool/requestUserInput",
      params: { id: "c", questions: [{ id: "x", header: "H", question: "Q?", options: [] }] },
    });
    expect(result).toEqual({ answers: {} });
  });
});

// ---------------------------------------------------------------------------
// Live synthetic eventId (codex:<thread>:<turn>:<item>:<type>)
// ---------------------------------------------------------------------------

describe("CodexSession — live event identity", () => {
  it("synthesizes a composite eventId for v2 events when thread+turn+item exist", async () => {
    const events: StreamEvent[] = [];
    const { proc } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_1" } }),
    });
    const session = new CodexSessionImpl(proc, { onEvent: (e) => events.push(e) }, "/tmp", "m", null);
    await session.handshake();

    const stdout = (proc as unknown as { stdout: EventEmitter }).stdout;
    stdout.emit(
      "data",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { turnId: "turn_1", item: { id: "item_3", type: "agentMessage", text: "hi" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 10));

    const ev = events.find((e) => e.type === "assistant");
    expect(ev?.eventId).toBe("codex:thr_1:turn_1:item_3:assistant");
  });

  it("leaves eventId null when turnId is missing (no fabricated identity)", async () => {
    const events: StreamEvent[] = [];
    const { proc } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_1" } }),
    });
    const session = new CodexSessionImpl(proc, { onEvent: (e) => events.push(e) }, "/tmp", "m", null);
    await session.handshake();

    const stdout = (proc as unknown as { stdout: EventEmitter }).stdout;
    stdout.emit(
      "data",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { item: { id: "item_9", type: "agentMessage", text: "hi" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 10));

    const ev = events.find((e) => e.type === "assistant");
    expect(ev).toBeDefined();
    expect(ev?.eventId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Collaboration mode selection (config.modeId)
// ---------------------------------------------------------------------------

describe("CodexSession — usage", () => {
  it("uses turn.completed usage verbatim (keyed by model) and skips the disk scan", async () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/tmp", "gpt-x", null);
    const h = await session.send("go"); // sets _turnStartedAt
    feedCodex(session, { type: "item.completed", item: { type: "agent_message", text: "done" } });
    // Usage present in the payload → the `if (!usage)` guard skips the scanner.
    feedCodex(session, { type: "turn.completed", usage: { input_tokens: 42, output_tokens: 7 } });
    const tr = await h.result;
    expect(tr.status).toBe("completed");
    expect(tr.usage).toEqual({ "gpt-x": { inputTokens: 42, outputTokens: 7 } });
  });
});

describe("CodexSession — collaboration mode", () => {
  it("resolves modeId via collaborationMode/list and passes collaborationMode to thread/start", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "collaborationMode/list": () => ({
        data: [
          { name: "Auto", mode: "code", model: "gpt-5.4" },
          { name: "Plan", mode: "plan", developer_instructions: "Investigate only." },
        ],
      }),
      "thread/start": () => ({ thread: { id: "thr_mode" } }),
    });
    const session = new CodexSessionImpl(proc, { config: { modeId: "plan" } }, "/tmp", null, null);
    await session.handshake();

    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toEqual({
      mode: "plan",
      settings: { developer_instructions: "Investigate only." },
    });
    expect(session.sessionId).toBe("thr_mode");
  });

  it("makes no collaborationMode/list call and sets no mode when modeId is unset", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "thr_default" } }),
    });
    const session = new CodexSessionImpl(proc, {}, "/tmp", null, null);
    await session.handshake();

    expect(methodsWritten(writes)).not.toContain("collaborationMode/list");
    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toBeUndefined();
    expect(session.sessionId).toBe("thr_default");
  });

  it("falls through to the default mode when modeId is unknown", async () => {
    const { proc, writes } = makeRpcProc({
      initialize: () => ({}),
      "collaborationMode/list": () => ({ data: [{ name: "Auto", mode: "code" }] }),
      "thread/start": () => ({ thread: { id: "thr_x" } }),
    });
    const session = new CodexSessionImpl(proc, { config: { modeId: "nonexistent" } }, "/tmp", null, null);
    await session.handshake();

    expect(methodsWritten(writes)).toContain("collaborationMode/list"); // it tried to resolve
    expect(paramsFor(writes, "thread/start")["collaborationMode"]).toBeUndefined(); // no match → default
  });
});

describe("CodexSession — describe()", () => {
  it("returns null before Codex assigns a thread id", () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/repo", "gpt-5-codex", null);
    expect(session.describe()).toBeNull();
  });

  it("returns a valid SessionRecord once the thread id is known", () => {
    const { proc } = makeFakeProc();
    const session = new CodexSessionImpl(proc, {}, "/repo", "gpt-5-codex", null);
    (session as unknown as { _threadId: string | null })._threadId = "thread-xyz";

    const rec = session.describe();
    expect(rec).not.toBeNull();
    expect(() => assertSessionRecord(rec)).not.toThrow();
    expect(rec!.version).toBe(1);
    expect(rec!.providerType).toBe("codex");
    expect(rec!.params).toMatchObject({ sessionId: "thread-xyz", cwd: "/repo" });
    expect(rec!.cwd).toBe("/repo");
    expect(rec!.displayId).toBe("thread-xyz");
  });
});
