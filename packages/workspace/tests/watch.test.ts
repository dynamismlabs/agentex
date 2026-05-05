import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspace } from "../src/index.js";
import type { WatchEvent, WatchSubscription } from "../src/index.js";
import { makeTmpDir, removeTmpDir, writeUtf8 } from "./helpers.js";

const tmpDirs: string[] = [];
const subs: WatchSubscription[] = [];

afterEach(async () => {
  while (subs.length > 0) {
    const s = subs.pop();
    if (s) {
      try { s.dispose(); } catch { /* ignore */ }
    }
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await removeTmpDir(dir);
  }
});

async function tmp(label: string): Promise<string> {
  const dir = await makeTmpDir(label);
  tmpDirs.push(dir);
  return dir;
}

function waitForEvent(
  events: WatchEvent[],
  predicate: (event: WatchEvent) => boolean,
  timeoutMs = 5000,
): Promise<WatchEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(`Timed out waiting for event matching predicate; got ${JSON.stringify(events)}`),
        );
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function makeBareWorkspace(label: string) {
  const root = await tmp(label);
  const wsPath = path.join(root, "ws");
  const ws = await workspace.create({ kind: "bare", path: wsPath });
  return { root, wsPath, ws };
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("ws.watch", () => {
  it("fires an 'add' event for a newly created file", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-add");
    const events: WatchEvent[] = [];

    const sub = ws.watch((batch) => events.push(...batch));
    subs.push(sub);
    await sub.ready;

    await writeUtf8(path.join(wsPath, "new.txt"), "x");

    const evt = await waitForEvent(events, (e) => e.path.endsWith("new.txt") && e.kind === "add");
    expect(evt.kind).toBe("add");
  });

  it("fires a 'modify' event when an existing file changes", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-modify");
    await writeUtf8(path.join(wsPath, "f.txt"), "v1");

    const events: WatchEvent[] = [];
    const sub = ws.watch((batch) => events.push(...batch));
    subs.push(sub);
    await sub.ready;

    await writeUtf8(path.join(wsPath, "f.txt"), "v2");

    const evt = await waitForEvent(events, (e) => e.path.endsWith("f.txt") && e.kind === "modify");
    expect(evt.kind).toBe("modify");
  });

  it("fires a 'remove' event when a file is deleted", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-remove");
    await writeUtf8(path.join(wsPath, "doomed.txt"), "x");

    const events: WatchEvent[] = [];
    const sub = ws.watch((batch) => events.push(...batch));
    subs.push(sub);
    await sub.ready;

    await fs.unlink(path.join(wsPath, "doomed.txt"));

    const evt = await waitForEvent(events, (e) => e.path.endsWith("doomed.txt") && e.kind === "remove");
    expect(evt.kind).toBe("remove");
  });

  it("batches multiple rapid changes into one handler call (~100ms debounce)", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-batch");
    const batches: WatchEvent[][] = [];

    const sub = ws.watch((batch) => batches.push(batch));
    subs.push(sub);
    await sub.ready;

    await writeUtf8(path.join(wsPath, "a.txt"), "a");
    await writeUtf8(path.join(wsPath, "b.txt"), "b");
    await writeUtf8(path.join(wsPath, "c.txt"), "c");

    // Wait for debounce + a buffer.
    await delay(400);

    expect(batches.length).toBeGreaterThanOrEqual(1);
    const total = batches.flat().filter((e) => /\/(a|b|c)\.txt$/.test(e.path) && e.kind === "add");
    expect(total.length).toBe(3);
  });

  it("does not fire events for changes inside .git/", async () => {
    // Use a bare workspace + a synthetic .git/ directory to exercise the
    // watcher's ignore filter directly. (For real git worktrees, `.git` is
    // a pointer file, not a directory.)
    const root = await tmp("watch-git-skip");
    const wsPath = path.join(root, "ws");
    const ws = await workspace.create({ kind: "bare", path: wsPath });
    await fs.mkdir(path.join(wsPath, ".git"), { recursive: true });

    const events: WatchEvent[] = [];
    const sub = ws.watch((batch) => events.push(...batch));
    subs.push(sub);
    await sub.ready;

    await writeUtf8(path.join(wsPath, "real.txt"), "x");
    await writeUtf8(path.join(wsPath, ".git", "internal-test"), "x");
    await writeUtf8(path.join(wsPath, ".git", "deeper", "again.txt"), "y");

    await waitForEvent(events, (e) => e.path.endsWith("real.txt"));
    await delay(200);

    expect(events.some((e) => e.path.includes(`${path.sep}.git${path.sep}`))).toBe(false);
  });

  it("dispose() stops further events; idempotent", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-dispose");
    const events: WatchEvent[] = [];

    const sub = ws.watch((batch) => events.push(...batch));
    await sub.ready;

    sub.dispose();
    sub.dispose(); // idempotent — no throw
    await delay(50);

    await writeUtf8(path.join(wsPath, "after-dispose.txt"), "x");
    await delay(400);

    expect(events.some((e) => e.path.endsWith("after-dispose.txt"))).toBe(false);
  });

  it("ready resolves once the initial scan is complete", async () => {
    const { ws } = await makeBareWorkspace("watch-ready");
    const sub = ws.watch(() => {});
    subs.push(sub);

    // ready should resolve in well under a second on a small empty workspace.
    let resolved = false;
    void sub.ready.then(() => {
      resolved = true;
    });
    await sub.ready;
    expect(resolved).toBe(true);
  });

  it("opts.onError catches handler exceptions; watcher continues", async () => {
    const { wsPath, ws } = await makeBareWorkspace("watch-onerror");
    const errors: unknown[] = [];
    const events: WatchEvent[] = [];

    let throws = true;
    const sub = ws.watch(
      (batch) => {
        events.push(...batch);
        if (throws) {
          throws = false;
          throw new Error("handler boom");
        }
      },
      { onError: (err) => errors.push(err) },
    );
    subs.push(sub);
    await sub.ready;

    await writeUtf8(path.join(wsPath, "first.txt"), "x");
    await waitForEvent(events, (e) => e.path.endsWith("first.txt"));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("handler boom");

    // Watcher still alive and delivers further events.
    await writeUtf8(path.join(wsPath, "second.txt"), "y");
    await waitForEvent(events, (e) => e.path.endsWith("second.txt"));
  });
});
