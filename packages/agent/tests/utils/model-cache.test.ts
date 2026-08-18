import { beforeEach, describe, expect, it } from "vitest";
import { clearModelCache, withModelCache } from "../../src/utils/model-cache.js";

beforeEach(() => clearModelCache());

function counter() {
  const state = { calls: 0 };
  return { state, load: async () => ++state.calls };
}

describe("withModelCache", () => {
  it("serves a second call from cache inside the TTL", async () => {
    const { state, load } = counter();
    expect(await withModelCache("claude", {}, 60_000, load)).toBe(1);
    expect(await withModelCache("claude", {}, 60_000, load)).toBe(1);
    expect(state.calls).toBe(1);
  });

  it("treats a zero or absent TTL as an explicit refresh", async () => {
    const { state, load } = counter();
    await withModelCache("claude", {}, 60_000, load);
    expect(await withModelCache("claude", {}, 0, load)).toBe(2);
    expect(await withModelCache("claude", {}, undefined, load)).toBe(3);
    expect(state.calls).toBe(3);
  });

  it("drops the stale entry on refresh so the next TTL read is not the old value", async () => {
    const { load } = counter();
    await withModelCache("claude", {}, 60_000, load);
    await withModelCache("claude", {}, 0, load);
    expect(await withModelCache("claude", {}, 60_000, load)).toBe(3);
  });

  it("separates providers, cwds, binaries, and credentials", async () => {
    const { state, load } = counter();
    const ttl = 60_000;
    await withModelCache("claude", {}, ttl, load);
    await withModelCache("codex", {}, ttl, load);
    await withModelCache("claude", { cwd: "/a" }, ttl, load);
    await withModelCache("claude", { config: { command: "/opt/claude" } }, ttl, load);
    await withModelCache("claude", { env: { TOKEN: "one" } }, ttl, load);
    await withModelCache("claude", { env: { TOKEN: "two" } }, ttl, load);
    expect(state.calls).toBe(6);
  });

  it("does not treat env key order as a different identity", async () => {
    const { state, load } = counter();
    await withModelCache("claude", { env: { A: "1", B: "2" } }, 60_000, load);
    await withModelCache("claude", { env: { B: "2", A: "1" } }, 60_000, load);
    expect(state.calls).toBe(1);
  });

  it("never caches a rejection, so a mid-upgrade CLI is retried", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("binary busy");
      return "ok";
    };
    await expect(withModelCache("claude", {}, 60_000, load)).rejects.toThrow("binary busy");
    expect(await withModelCache("claude", {}, 60_000, load)).toBe("ok");
  });

  it("clears one provider without evicting the others", async () => {
    const { state, load } = counter();
    await withModelCache("claude", {}, 60_000, load);
    await withModelCache("codex", {}, 60_000, load);
    clearModelCache("claude");
    await withModelCache("codex", {}, 60_000, load);
    expect(state.calls).toBe(2);
    await withModelCache("claude", {}, 60_000, load);
    expect(state.calls).toBe(3);
  });
});
