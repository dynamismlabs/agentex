import { describe, expect, it, vi } from "vitest";
import { generateTitle } from "../src/titles.js";

describe("generateTitle", () => {
  it("uses native generation without invoking the host fallback", async () => {
    const native = vi.fn(async () => "  Native\n title  ");
    const fallback = vi.fn(async () => "Fallback");
    expect(await generateTitle({ generateNativeTitle: native }, {
      description: "request", fallbackTitleGenerator: fallback,
    })).toEqual({ title: "Native title", source: "native" });
    expect(native).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "empty", "failed"] as const)("uses an explicit fallback once on %s", async (reason) => {
    const failure = new Error("Native failure");
    const native = reason === "unsupported" ? null : { generateNativeTitle: async () => {
      if (reason === "failed") throw failure;
      return "   ";
    } };
    const fallback = vi.fn(async () => "Host title");
    expect(await generateTitle(native, { description: "request", fallbackTitleGenerator: fallback }))
      .toEqual({ title: "Host title", source: "fallback" });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: "request", reason }));
    if (reason === "failed") expect(fallback.mock.calls[0]?.[0]).toMatchObject({ error: failure });
  });

  it("returns null without an explicit fallback and when fallback yields no title", async () => {
    expect(await generateTitle(null, { description: "request" })).toBeNull();
    expect(await generateTitle(null, { description: "request", fallbackTitleGenerator: async () => null })).toBeNull();
  });

  it("propagates host generator failures", async () => {
    const failure = new Error("Host failure");
    await expect(generateTitle(null, { description: "request", fallbackTitleGenerator: async () => { throw failure; } }))
      .rejects.toBe(failure);
  });

  it("never invokes a generator for an already aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    const native = vi.fn(async () => "Native"); const fallback = vi.fn(async () => "Fallback");
    await expect(generateTitle({ generateNativeTitle: native }, {
      description: "request", signal: controller.signal, fallbackTitleGenerator: fallback,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(native).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });

  it("cancels a pending native request without starting fallback", async () => {
    const controller = new AbortController();
    const fallback = vi.fn(async () => "Fallback");
    const result = generateTitle({ generateNativeTitle: () => new Promise(() => {}) }, {
      description: "request", signal: controller.signal, fallbackTitleGenerator: fallback,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("propagates a native cancellation even without a host signal", async () => {
    const fallback = vi.fn(async () => "Fallback");
    await expect(generateTitle({ generateNativeTitle: async () => { throw new DOMException("Aborted", "AbortError"); } }, {
      description: "request", fallbackTitleGenerator: fallback,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("cancels an uncooperative pending fallback", async () => {
    const controller = new AbortController();
    const result = generateTitle(null, { description: "request", signal: controller.signal,
      fallbackTitleGenerator: () => new Promise(() => {}),
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
