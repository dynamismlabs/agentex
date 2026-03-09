import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../../src/sessions/store.js";
import { IdleSessionReaper } from "../../src/sessions/reaper.js";
import type { SessionEntry, GatewayEventEmitter } from "../../src/types.js";

function makeEntry(
  key: string,
  lastActivityAt: number,
  sessionParams: Record<string, unknown> | null = { agentSessionId: "s1" },
): SessionEntry {
  return {
    key,
    sessionParams,
    lastChannel: "slack",
    lastRoute: { channel: "slack", target: "C123" },
    lastActivityAt,
  };
}

function makeEvents(): GatewayEventEmitter {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

describe("IdleSessionReaper", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function makeTmpDir(): Promise<string> {
    vi.useRealTimers();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-test-"));
    vi.useFakeTimers();
    return tmpDir;
  }

  it("reaps sessions that exceed idle threshold", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();

    // Session that has been idle for 2 hours
    store.set("old", makeEntry("old", now - 2 * 60 * 60 * 1000));
    // Session that is still active (5 minutes ago)
    store.set("recent", makeEntry("recent", now - 5 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);

    await reaper.reap();

    // Old session should have been reset
    const oldSession = store.get("old");
    expect(oldSession).toBeDefined();
    expect(oldSession!.sessionParams).toBeNull();

    // Recent session should be untouched
    const recentSession = store.get("recent");
    expect(recentSession).toBeDefined();
    expect(recentSession!.sessionParams).toEqual({ agentSessionId: "s1" });
  });

  it("emits session.reset event for reaped sessions", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();
    store.set("expired", makeEntry("expired", now - 2 * 60 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);

    await reaper.reap();

    expect(events.emit).toHaveBeenCalledWith(
      "session.reset",
      expect.objectContaining({
        sessionKey: "expired",
        reason: "idle",
        idleDuration: "1h",
      }),
      "expired",
    );
  });

  it("does not emit events for active sessions", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();
    store.set("active", makeEntry("active", now - 5 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);

    await reaper.reap();

    expect(events.emit).not.toHaveBeenCalled();
  });

  it("persists after reaping", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();
    store.set("old", makeEntry("old", now - 2 * 60 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);

    await reaper.reap();

    // Load into a fresh store to verify persistence
    vi.useRealTimers();
    const store2 = new SessionStore(dir);
    await store2.load();
    vi.useFakeTimers();

    const loaded = store2.get("old");
    expect(loaded).toBeDefined();
    expect(loaded!.sessionParams).toBeNull();
  });

  it("start creates a recurring interval", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    // Mock persist to avoid real fs during interval-triggered reap
    vi.spyOn(store, "persist").mockResolvedValue();

    const now = Date.now();
    store.set("old", makeEntry("old", now - 2 * 60 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);
    reaper.start();

    // Advance 60 seconds (the reap interval)
    await vi.advanceTimersByTimeAsync(60_000);

    // Should have reaped on the first tick
    expect(events.emit).toHaveBeenCalledWith(
      "session.reset",
      expect.objectContaining({ sessionKey: "old" }),
      "old",
    );

    reaper.stop();
  });

  it("stop clears the interval", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();
    store.set("old", makeEntry("old", now - 2 * 60 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);
    reaper.start();
    reaper.stop();

    // Advance time — reap should not run
    await vi.advanceTimersByTimeAsync(120_000);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it("start is idempotent", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    // Mock persist to avoid real fs during interval-triggered reap
    vi.spyOn(store, "persist").mockResolvedValue();

    const reaper = new IdleSessionReaper(store, "1h", events);
    reaper.start();
    reaper.start(); // should not create a second interval

    // Only one reap should happen per interval
    const now = Date.now();
    store.set("x", makeEntry("x", now - 2 * 60 * 60 * 1000));

    await vi.advanceTimersByTimeAsync(60_000);

    // Should have been called exactly once (for the one session)
    const emitCalls = vi.mocked(events.emit).mock.calls.filter(
      (c) => c[0] === "session.reset",
    );
    expect(emitCalls).toHaveLength(1);

    reaper.stop();
  });

  it("reaps multiple expired sessions at once", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);
    const events = makeEvents();

    const now = Date.now();
    store.set("expired-1", makeEntry("expired-1", now - 3 * 60 * 60 * 1000));
    store.set("expired-2", makeEntry("expired-2", now - 5 * 60 * 60 * 1000));
    store.set("active", makeEntry("active", now - 30 * 60 * 1000));

    const reaper = new IdleSessionReaper(store, "1h", events);

    await reaper.reap();

    expect(store.get("expired-1")!.sessionParams).toBeNull();
    expect(store.get("expired-2")!.sessionParams).toBeNull();
    expect(store.get("active")!.sessionParams).toEqual({
      agentSessionId: "s1",
    });

    const emitCalls = vi.mocked(events.emit).mock.calls.filter(
      (c) => c[0] === "session.reset",
    );
    expect(emitCalls).toHaveLength(2);
  });
});
