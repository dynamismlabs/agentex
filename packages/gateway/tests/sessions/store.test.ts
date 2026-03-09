import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../../src/sessions/store.js";
import type { SessionEntry } from "../../src/types.js";

function makeEntry(key: string): SessionEntry {
  return {
    key,
    sessionParams: null,
    lastChannel: "test",
    lastRoute: { channel: "test", target: "u1" },
    lastActivityAt: Date.now(),
  };
}

describe("SessionStore", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function makeTmpDir(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-test-"));
    return tmpDir;
  }

  it("get/set/delete work on the in-memory map", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    const entry = makeEntry("k1");
    store.set("k1", entry);
    expect(store.get("k1")).toEqual(entry);

    store.delete("k1");
    expect(store.get("k1")).toBeUndefined();
  });

  it("getAll returns all entries", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    store.set("a", makeEntry("a"));
    store.set("b", makeEntry("b"));

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.key).sort()).toEqual(["a", "b"]);
  });

  it("persist and load roundtrip", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    const entry = makeEntry("session-1");
    entry.model = "claude-4";
    entry.lastSenderId = "user-42";
    store.set("session-1", entry);
    await store.persist();

    // Load into a fresh store
    const store2 = new SessionStore(dir);
    await store2.load();

    expect(store2.get("session-1")).toEqual(entry);
    expect(store2.getAll()).toHaveLength(1);
  });

  it("load handles missing file gracefully", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    await store.load();
    expect(store.getAll()).toHaveLength(0);
  });

  it("persist writes atomically (no .tmp file left behind)", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    store.set("x", makeEntry("x"));
    await store.persist();

    const files = await fs.readdir(dir);
    expect(files).toContain("sessions.json");
    expect(files).not.toContain("sessions.json.tmp");
  });

  it("persist creates stateDir if it does not exist", async () => {
    const dir = await makeTmpDir();
    const nested = path.join(dir, "nested", "state");
    const store = new SessionStore(nested);

    store.set("y", makeEntry("y"));
    await store.persist();

    const store2 = new SessionStore(nested);
    await store2.load();
    expect(store2.get("y")).toBeDefined();
  });

  it("persist overwrites previous data", async () => {
    const dir = await makeTmpDir();
    const store = new SessionStore(dir);

    store.set("a", makeEntry("a"));
    await store.persist();

    store.delete("a");
    store.set("b", makeEntry("b"));
    await store.persist();

    const store2 = new SessionStore(dir);
    await store2.load();
    expect(store2.get("a")).toBeUndefined();
    expect(store2.get("b")).toBeDefined();
    expect(store2.getAll()).toHaveLength(1);
  });
});
