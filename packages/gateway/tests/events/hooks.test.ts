import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayEventPayload, Logger } from "../../src/types.js";

// Mock child_process before importing executeHook
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { executeHook } from "../../src/events/hooks.js";

const mockedExec = vi.mocked(exec);

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makePayload(overrides?: Partial<GatewayEventPayload>): GatewayEventPayload {
  return {
    type: "agent.complete",
    seq: 1,
    ts: 1700000000000,
    data: {},
    ...overrides,
  };
}

describe("executeHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders template variables from payload data and calls exec", () => {
    const log = makeLogger();
    const payload = makePayload({
      data: { result: "success", summary: "done" },
    });

    executeHook({ command: "notify --status={{result}} --msg={{summary}}" }, payload, log);

    expect(mockedExec).toHaveBeenCalledOnce();
    expect(mockedExec).toHaveBeenCalledWith(
      "notify --status=success --msg=done",
      expect.any(Function),
    );
  });

  it("renders top-level payload fields (type, seq, ts) as template data", () => {
    const log = makeLogger();
    const payload = makePayload({ type: "test.event", seq: 42, ts: 1234567890 });

    executeHook({ command: "log {{type}} {{seq}} {{ts}}" }, payload, log);

    expect(mockedExec).toHaveBeenCalledWith(
      "log test.event 42 1234567890",
      expect.any(Function),
    );
  });

  it("renders sessionKey as template data", () => {
    const log = makeLogger();
    const payload = makePayload({ sessionKey: "sess-abc" });

    executeHook({ command: "hook --session={{sessionKey}}" }, payload, log);

    expect(mockedExec).toHaveBeenCalledWith(
      "hook --session=sess-abc",
      expect.any(Function),
    );
  });

  it("replaces missing template variables with empty string", () => {
    const log = makeLogger();
    const payload = makePayload({ data: {} });

    executeHook({ command: "cmd --arg={{missing}}" }, payload, log);

    expect(mockedExec).toHaveBeenCalledWith(
      "cmd --arg=",
      expect.any(Function),
    );
  });

  it("logs error when exec callback reports an error", () => {
    const log = makeLogger();
    const payload = makePayload();
    const execError = new Error("command not found");

    mockedExec.mockImplementation((_cmd: unknown, callback: unknown) => {
      (callback as (err: Error | null) => void)(execError);
      return undefined as never;
    });

    executeHook({ command: "bad-command" }, payload, log);

    expect(log.error).toHaveBeenCalledWith(
      "Hook command failed: %s",
      "command not found",
    );
  });

  it("logs error and does not throw when exec itself throws", () => {
    const log = makeLogger();
    const payload = makePayload();

    mockedExec.mockImplementation(() => {
      throw new Error("spawn error");
    });

    expect(() => executeHook({ command: "cmd" }, payload, log)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith("Hook execution failed", expect.any(Error));
  });

  it("does not throw even if everything fails", () => {
    const log = makeLogger();
    const payload = makePayload();

    mockedExec.mockImplementation(() => {
      throw new Error("fail");
    });

    expect(() => executeHook({ command: "anything" }, payload, log)).not.toThrow();
  });
});
