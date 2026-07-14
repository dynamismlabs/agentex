import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SavedHistorySession,
  SavedHistoryYield,
} from "../../../src/history/types.js";
import type { OpenCodeClient } from "../../../src/providers/opencode/client.js";

const runtime = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../src/providers/opencode/runtime.js", () => ({
  acquireOpenCodeRuntime: runtime.acquire,
}));

import {
  discoverOpenCodeSavedSessions,
  OpenCodeSavedHistoryInvalidSessionError,
  openCodeSavedHistory,
  readOpenCodeSavedSession,
} from "../../../src/providers/opencode/saved-history.js";

function session(
  id: string,
  directory: string,
  updated: number,
  options: { parentID?: string; archived?: number; title?: string } = {},
) {
  return {
    id,
    directory,
    title: options.title ?? `Session ${id}`,
    ...(options.parentID ? { parentID: options.parentID } : {}),
    time: {
      created: updated - 1_000,
      updated,
      ...(options.archived ? { archived: options.archived } : {}),
    },
  };
}

function userMessage(sessionId: string, index = 1, text = `prompt-${index}`) {
  return {
    info: {
      id: `msg_user_${index}`,
      role: "user",
      time: { created: 1_700_000_000_000 + index },
    },
    parts: [{
      id: `part_user_${index}`,
      messageID: `msg_user_${index}`,
      sessionID: sessionId,
      type: "text",
      text,
    }],
  };
}

function assistantMessage(sessionId: string, index = 2, text = `answer-${index}`) {
  return {
    info: {
      id: `msg_assistant_${index}`,
      role: "assistant",
      finish: "stop",
      time: { created: 1_700_000_000_000 + index },
    },
    parts: [{
      id: `part_assistant_${index}`,
      messageID: `msg_assistant_${index}`,
      sessionID: sessionId,
      type: "text",
      text,
    }],
  };
}

function fakeClient(
  handler: (path: string) => Response | Promise<Response>,
): { client: OpenCodeClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async request(path: string) {
      calls.push(path);
      return handler(path);
    },
  } as unknown as OpenCodeClient;
  return { client, calls };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function descriptor(id = "ses_one"): SavedHistorySession {
  return {
    version: 1,
    providerType: "opencode",
    externalSessionId: id,
    cwd: "/project-a",
    title: "One",
    startedAt: "2023-11-14T22:13:20.000Z",
    updatedAt: "2023-11-14T22:13:21.000Z",
    branch: null,
    gitOriginUrl: null,
    archiveState: "active",
    hasUserMessage: true,
  };
}

describe("OpenCode saved history", () => {
  beforeEach(() => {
    runtime.acquire.mockReset();
    runtime.release.mockReset();
  });

  it("discovers root sessions across projects through the global endpoint", async () => {
    const { client, calls } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        return Response.json([
          session("ses_a", "/project-a", 1_700_000_002_000),
          session("ses_b", "/project-b", 1_700_000_001_000, {
            archived: 1_700_000_003_000,
          }),
        ]);
      }
      const id = path.includes("ses_a") ? "ses_a" : "ses_b";
      return Response.json([userMessage(id)]);
    });

    const sessions = await collect(discoverOpenCodeSavedSessions(client, { cwd: "/flow-app" }));

    expect(sessions.map((item) => [item.externalSessionId, item.cwd])).toEqual([
      ["ses_a", "/project-a"],
      ["ses_b", "/project-b"],
    ]);
    expect(sessions[1]?.archiveState).toBe("archived");
    const listCall = calls[0]!;
    expect(listCall).toContain("/experimental/session?");
    expect(listCall).toContain("roots=true");
    expect(listCall).toContain("archived=true");
    expect(listCall).not.toContain("directory=");
  });

  it("uses an explicit directory filter without confusing it with runtime cwd", async () => {
    const { client, calls } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        return Response.json([session("ses_a", "/project-a", 1_700_000_002_000)]);
      }
      return Response.json([userMessage("ses_a")]);
    });

    await collect(discoverOpenCodeSavedSessions(client, {
      cwd: "/flow-app",
      directory: "/project-a",
    }));

    expect(calls[0]).toContain("directory=%2Fproject-a");
    expect(calls[0]).not.toContain("flow-app");
  });

  it("paginates the global list and preserves most-recent-first ordering", async () => {
    const { client, calls } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        if (path.includes("cursor=1700000001000")) {
          return Response.json([session("ses_old", "/project-old", 1_700_000_000_000)]);
        }
        return Response.json(
          [session("ses_new", "/project-new", 1_700_000_001_000)],
          { headers: { "x-next-cursor": "1700000001000" } },
        );
      }
      const id = path.includes("ses_new") ? "ses_new" : "ses_old";
      return Response.json([userMessage(id)]);
    });

    const sessions = await collect(discoverOpenCodeSavedSessions(client));

    expect(sessions.map((item) => item.externalSessionId)).toEqual(["ses_new", "ses_old"]);
    expect(calls.some((path) => path.includes("cursor=1700000001000"))).toBe(true);
  });

  it("falls back to the legacy global list without imposing the runtime cwd", async () => {
    const { client, calls } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) return new Response(null, { status: 404 });
      if (path.startsWith("/session?")) {
        return Response.json([
          session("ses_a", "/project-a", 1_700_000_002_000),
          session("ses_b", "/project-b", 1_700_000_001_000),
        ]);
      }
      const id = path.includes("ses_a") ? "ses_a" : "ses_b";
      return Response.json([userMessage(id)]);
    });

    const sessions = await collect(discoverOpenCodeSavedSessions(client));

    expect(sessions).toHaveLength(2);
    const legacyCall = calls.find((path) => path.startsWith("/session?"))!;
    expect(legacyCall).toContain("roots=true");
    expect(legacyCall).not.toContain("directory=");
  });

  it("filters sessions without a meaningful user prompt by default", async () => {
    const { client } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        return Response.json([
          session("ses_empty", "/empty", 1_700_000_002_000),
          session("ses_real", "/real", 1_700_000_001_000),
        ]);
      }
      if (path.includes("ses_empty")) return Response.json([assistantMessage("ses_empty")]);
      return Response.json([userMessage("ses_real", 1, "Import this conversation")]);
    });

    const sessions = await collect(discoverOpenCodeSavedSessions(client));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      externalSessionId: "ses_real",
      hasUserMessage: true,
    });
  });

  it("skips a session that disappears during inspection without hiding healthy sessions", async () => {
    const { client } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        return Response.json([
          session("ses_broken", "/broken", 1_700_000_002_000),
          session("ses_healthy", "/healthy", 1_700_000_001_000),
        ]);
      }
      if (path.includes("ses_broken")) return new Response(null, { status: 500 });
      return Response.json([userMessage("ses_healthy")]);
    });

    const sessions = await collect(discoverOpenCodeSavedSessions(client));

    expect(sessions.map((item) => item.externalSessionId)).toEqual(["ses_healthy"]);
  });

  it("fails explicitly when aggregate discovery inspection exceeds its message budget", async () => {
    const firstPage = Array.from(
      { length: 100 },
      (_, index) => session(`ses_${index}`, `/project-${index}`, 1_700_001_000_000 - index),
    );
    const messagePayload = JSON.stringify(Array.from(
      { length: 100 },
      (_, index) => assistantMessage("ses_scan", index + 1),
    ));
    const { client } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        if (path.includes("cursor=1699999999900")) {
          return Response.json([session("ses_100", "/project-100", 1_699_999_999_899)]);
        }
        return Response.json(firstPage, {
          headers: { "x-next-cursor": "1699999999900" },
        });
      }
      return new Response(messagePayload, {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(collect(discoverOpenCodeSavedSessions(client)))
      .rejects.toMatchObject({ code: "history_discovery_limit" });
  });

  it("reads user and assistant history with opaque incremental checkpoints", async () => {
    const messages = [
      userMessage("ses_one", 1, "Original prompt"),
      assistantMessage("ses_one", 2, "Original answer"),
    ];
    const { client } = fakeClient(() => Response.json(messages));

    const initial = await collect(readOpenCodeSavedSession(client, descriptor(), {
      mode: "bounded_full_resync",
    }));

    expect(initial.map((item) => item.event.type)).toEqual(["user", "assistant", "result"]);
    expect(initial[0]).toMatchObject({
      eventId: "msg_user_1",
      partIndex: 0,
      event: { type: "user", text: "Original prompt", providerType: "opencode" },
      checkpoint: { kind: "opencode:message-part:v2" },
    });

    const resumed = await collect(readOpenCodeSavedSession(client, descriptor(), {
      after: initial[0]!.checkpoint,
      mode: "incremental",
    }));
    expect(resumed.map((item) => item.event.type)).toEqual(["assistant", "result"]);
  });

  it("rejects descriptors owned by another provider", async () => {
    const { client } = fakeClient(() => Response.json([]));
    const invalid = { ...descriptor(), providerType: "codex" };
    await expect(collect(readOpenCodeSavedSession(client, invalid)))
      .rejects.toBeInstanceOf(OpenCodeSavedHistoryInvalidSessionError);
  });

  it("reports source_missing when a session is deleted after discovery", async () => {
    const { client } = fakeClient(() => new Response(null, { status: 404 }));

    await expect(collect(readOpenCodeSavedSession(client, descriptor())))
      .rejects.toMatchObject({
        name: "OpenCodeHistorySourceMissingError",
        code: "source_missing",
      });
  });

  it("releases the service runtime when discovery is stopped early", async () => {
    const { client } = fakeClient((path) => {
      if (path.startsWith("/experimental/session?")) {
        return Response.json([session("ses_one", "/project-a", 1_700_000_001_000)]);
      }
      return Response.json([userMessage("ses_one")]);
    });
    runtime.acquire.mockResolvedValue({ server: { client, release: runtime.release } });

    const iterator = openCodeSavedHistory.discover()[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.externalSessionId).toBe("ses_one");
    await iterator.return?.();

    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it("reads cross-project history using the discovered session cwd", async () => {
    const { client } = fakeClient(() => Response.json([
      userMessage("ses_one"),
      assistantMessage("ses_one"),
    ]));
    runtime.acquire.mockResolvedValue({ server: { client, release: runtime.release } });

    await collect(openCodeSavedHistory.read(descriptor(), {
      cwd: "/flow-app",
      env: { XDG_DATA_HOME: "/isolated" },
    }));

    expect(runtime.acquire).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/project-a",
      env: { XDG_DATA_HOME: "/isolated" },
    }));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it("reports an unavailable source when the local service cannot start", async () => {
    runtime.acquire.mockRejectedValue(new Error("binary missing"));
    await expect(openCodeSavedHistory.probe()).resolves.toEqual({
      providerType: "opencode",
      sourceAvailable: false,
      historyAvailable: false,
    });
  });
});

// Compile-time assertion that checkpoints and user events remain reachable in
// the provider-neutral public yield shape.
const _yieldType: SavedHistoryYield | null = null;
void _yieldType;
