/**
 * Approval requests, against the shape `codex app-server generate-json-schema`
 * actually declares on 0.148.
 *
 * The old fixtures encoded `{ id, command }`, which the protocol has never had
 * — the field is `itemId`, and `FileChangeRequestApprovalParams` carries
 * `grantRoot` rather than `path`. Because the fixture was the only spec these
 * handlers were checked against, the drift was invisible: `toolUseId` was
 * always `""` and file-change approvals arrived with no description.
 *
 * `threadId` and `turnId` are required on every one of these requests, which is
 * what makes thread scoping possible rather than guesswork.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexSessionImpl } from "../../../src/providers/codex/session.js";
import type { UserInputRequest, UserInputResponse } from "../../../src/types.js";

function session(onUserInputRequest?: (r: UserInputRequest) => Promise<UserInputResponse>) {
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
  const impl = new CodexSessionImpl(
    proc,
    onUserInputRequest ? { onUserInputRequest } : {},
    "/tmp",
    "test-model",
    null,
  );
  (impl as unknown as { _threadId: string | null })._threadId = "root-thread";
  (impl as unknown as { _state: string })._state = "thinking";
  return { impl, writes };
}

const feed = async (impl: CodexSessionImpl, message: unknown) => {
  (impl as unknown as { handleLine: (l: string) => void }).handleLine(JSON.stringify(message));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

const commandApproval = (threadId: string) => ({
  jsonrpc: "2.0",
  id: 41,
  method: "item/commandExecution/requestApproval",
  params: {
    itemId: "item_7",
    startedAtMs: 1,
    threadId,
    turnId: "turn-1",
    command: "rm -rf build",
    reason: "cleaning",
  },
});

describe("approval request fields", () => {
  it("reads the tool use id from itemId", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => { seen = request; return { allow: true }; });
    await feed(impl, commandApproval("root-thread"));
    expect(seen!.toolUseId).toBe("item_7");
  });

  it("describes a file-change approval from grantRoot instead of a field that does not exist", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => { seen = request; return { allow: true }; });
    await feed(impl, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item_8", startedAtMs: 1, threadId: "root-thread", turnId: "t", grantRoot: "/repo/src" },
    });
    expect(seen!.toolUseId).toBe("item_8");
    expect(seen!.description).toBe("/repo/src");
  });
});

describe("approval thread scoping", () => {
  it("does not drive root state from a child thread's approval", async () => {
    const { impl, writes } = session(async () => {
      // Root must not look blocked while a subagent waits on its own approval.
      expect(impl.state).toBe("thinking");
      return { allow: true };
    });
    await feed(impl, commandApproval("child-thread"));
    expect(impl.state).toBe("thinking");
    expect(writes.find((w) => w["id"] === 41)?.["result"]).toEqual({ decision: "accept" });
  });

  it("attributes a child approval to the subagent that asked", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => { seen = request; return { allow: true }; });
    await feed(impl, commandApproval("child-thread"));
    // Same id the child's background_task carries, so a host can pair them.
    expect(seen!.agentId).toBe("child-thread");
  });

  it("leaves a root approval unattributed and still gates root state", async () => {
    let stateDuring: string | null = null;
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => {
      seen = request;
      stateDuring = impl.state;
      return { allow: true };
    });
    await feed(impl, commandApproval("root-thread"));
    expect(stateDuring).toBe("waiting_for_approval");
    expect(seen!.agentId).toBeUndefined();
  });
});

const userInputRequest = (threadId: string) => ({
  jsonrpc: "2.0",
  id: 44,
  method: "item/tool/requestUserInput",
  params: {
    isBlocking: true,
    itemId: "item-9",
    threadId,
    turnId: "turn-1",
    questions: [{ id: "q1", question: "Which database?", options: ["postgres", "sqlite"] }],
  },
});

describe("user input request scoping", () => {
  // Third handler in the same file with the same defect. The two approval
  // handlers were scoped first and this one was missed, so a child subagent's
  // question blocked the root session and arrived unattributable.
  it("does not drive root state from a child thread's question", async () => {
    const { impl } = session(async () => {
      expect(impl.state).toBe("thinking");
      return { allow: true };
    });
    await feed(impl, userInputRequest("child-thread-7"));
    expect(impl.state).toBe("thinking");
  });

  it("attributes a child question to the subagent that asked", async () => {
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => { seen = request; return { allow: true }; });
    await feed(impl, userInputRequest("child-thread-7"));
    expect(seen!.agentId).toBe("child-thread-7");
    expect(seen!.toolUseId).toBe("item-9");
  });

  it("still gates root state on a root question and leaves it unattributed", async () => {
    let stateDuring: string | null = null;
    let seen: UserInputRequest | null = null;
    const { impl } = session(async (request) => {
      seen = request;
      stateDuring = impl.state;
      return { allow: true };
    });
    await feed(impl, userInputRequest("root-thread"));
    expect(stateDuring).toBe("waiting_for_input");
    expect(seen!.agentId).toBeUndefined();
  });
});

describe("item/permissions/requestApproval", () => {
  const request = (allowShape: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 43,
    method: "item/permissions/requestApproval",
    params: {
      itemId: "item_9",
      startedAtMs: 1,
      threadId: "root-thread",
      turnId: "t",
      cwd: "/repo",
      permissions: allowShape,
      reason: "needs network",
    },
  });

  it("grants the requested profile when the host allows", async () => {
    const { impl, writes } = session(async () => ({ allow: true }));
    const wanted = { network: { allowedDomains: ["example.com"] } };
    await feed(impl, request(wanted));
    expect(writes.find((w) => w["id"] === 43)?.["result"]).toEqual({ permissions: wanted });
  });

  it("grants nothing when the host denies", async () => {
    const { impl, writes } = session(async () => ({ allow: false }));
    await feed(impl, request({ network: { allowedDomains: ["example.com"] } }));
    expect(writes.find((w) => w["id"] === 43)?.["result"]).toEqual({ permissions: {} });
  });

  it("refuses rather than widening the sandbox when no host handler exists", async () => {
    // Previously this fell to the generic `{}` ack, which the schema rejects:
    // PermissionsRequestApprovalResponse requires `permissions`.
    const { impl, writes } = session();
    await feed(impl, request({ network: { allowedDomains: ["example.com"] } }));
    expect(writes.find((w) => w["id"] === 43)?.["result"]).toEqual({ permissions: {} });
  });
});
