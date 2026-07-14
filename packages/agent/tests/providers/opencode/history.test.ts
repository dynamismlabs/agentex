import { describe, expect, it } from "vitest";
import type { OpenCodeClient } from "../../../src/providers/opencode/client.js";
import {
  collectHistory,
  historicalEvents,
  OpenCodeHistoryCheckpointNotFoundError,
} from "../../../src/providers/opencode/history.js";

function message(index: number, role: "assistant" | "user" = "assistant") {
  return {
    info: {
      id: `msg_${String(index).padStart(4, "0")}`,
      role,
      finish: role === "assistant" ? "stop" : undefined,
      time: { created: 1_700_000_000_000 + index },
    },
    parts: [{
      id: `part_${String(index).padStart(4, "0")}`,
      messageID: `msg_${String(index).padStart(4, "0")}`,
      sessionID: "ses_test",
      type: "text",
      text: `text-${index}`,
    }],
  };
}

function pagedClient() {
  const calls: string[] = [];
  const newest = Array.from({ length: 100 }, (_, index) => message(index + 100));
  const oldest = Array.from({ length: 100 }, (_, index) => message(index));
  const client = {
    async request(path: string) {
      calls.push(path);
      if (path.includes("before=older-page")) return Response.json(oldest);
      return Response.json(newest, { headers: { "x-next-cursor": "older-page" } });
    },
  } as unknown as OpenCodeClient;
  return { client, calls };
}

describe("OpenCode durable history", () => {
  it("paginates backward with opaque cursors and emits chronologically", async () => {
    const { client, calls } = pagedClient();
    const result = await collectHistory(client, "ses_test", undefined);
    const assistant = result.filter((item) => item.event.type === "assistant");
    expect(assistant).toHaveLength(200);
    expect(assistant[0]?.event).toMatchObject({ type: "assistant", text: "text-0" });
    expect(assistant.at(-1)?.event).toMatchObject({ type: "assistant", text: "text-199" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("before=");
    expect(calls[1]).toContain("before=older-page");
  });

  it("discards every event through the checkpoint part", async () => {
    const { client } = pagedClient();
    const initial = await collectHistory(client, "ses_test", { mode: "bounded_full_resync" });
    const after = initial.findLast((item) => item.event.messageId === "msg_0150")!.checkpoint;
    const result = await collectHistory(client, "ses_test", {
      after,
    });
    const assistant = result.filter((item) => item.event.type === "assistant");
    expect(assistant[0]?.event).toMatchObject({ text: "text-151" });
    expect(result.some((item) => item.event.messageId === "msg_0150")).toBe(false);
  });

  it("does not replay another event from the same part after its terminal checkpoint", async () => {
    const oneMessage = message(1);
    const client = {
      async request() { return Response.json([oneMessage]); },
    } as unknown as OpenCodeClient;
    const initial = await collectHistory(client, "ses_test", { mode: "bounded_full_resync" });
    expect(initial.map((item) => item.event.type)).toEqual(["assistant", "result"]);

    const resumed = await collectHistory(client, "ses_test", {
      mode: "incremental",
      after: initial.at(-1)!.checkpoint,
    });
    expect(resumed).toEqual([]);
  });

  it("returns a typed error when a checkpoint message or part is missing", async () => {
    const { client } = pagedClient();
    const initial = await collectHistory(client, "ses_test", { mode: "bounded_full_resync" });
    const existing = initial.findLast((item) => item.event.messageId === "msg_0150")!.checkpoint;
    await expect(collectHistory(client, "ses_test", {
      after: {
        ...existing,
        value: { ...existing.value as object, messageId: "msg_missing" },
      },
    })).rejects.toBeInstanceOf(OpenCodeHistoryCheckpointNotFoundError);
    await expect(collectHistory(client, "ses_test", {
      after: {
        ...existing,
        value: { ...existing.value as object, partId: "part_missing" },
      },
    })).rejects.toBeInstanceOf(OpenCodeHistoryCheckpointNotFoundError);
  });

  it("invalidates a checkpoint when its message mutates in place", async () => {
    const original = message(1);
    const client = {
      async request() { return Response.json([original]); },
    } as unknown as OpenCodeClient;
    const initial = await collectHistory(client, "ses_test", { mode: "bounded_full_resync" });
    const after = initial.at(-1)!.checkpoint;

    original.parts[0]!.text = "changed after checkpoint";

    await expect(collectHistory(client, "ses_test", { after, mode: "incremental" }))
      .rejects.toBeInstanceOf(OpenCodeHistoryCheckpointNotFoundError);
  });

  it("does not emit a completed result for an unfinished assistant message", () => {
    const running = message(1);
    delete running.info.finish;
    expect(historicalEvents(running, "ses_test").map((item) => item.event.type))
      .toEqual(["assistant"]);
  });

  it("preserves empty-on-404 behavior for known-session attachment catch-up", async () => {
    const client = {
      async request() { return new Response(null, { status: 404 }); },
    } as unknown as OpenCodeClient;
    await expect(collectHistory(client, "ses_deleted", undefined)).resolves.toEqual([]);
  });

  it("uses stable OpenCode IDs and includes user messages only for imports", () => {
    expect(historicalEvents(message(1, "user"), "ses_test")).toEqual([]);
    expect(historicalEvents(message(1, "user"), "ses_test", {
      includeUserMessages: true,
    })[0]?.event).toMatchObject({
      type: "user",
      text: "text-1",
      providerType: "opencode",
      sessionId: "ses_test",
      messageId: "msg_0001",
      eventId: "msg_0001",
    });
    const events = historicalEvents(message(2), "ses_test");
    expect(events[0]?.event).toMatchObject({
      providerType: "opencode",
      sessionId: "ses_test",
      messageId: "msg_0002",
      eventId: "part_0002",
    });
  });
});
