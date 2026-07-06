import { describe, it, expect, afterEach, vi } from "vitest";
import { uuidv7 } from "../../src/utils/uuid.js";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** First 48 bits (the ms timestamp) as 12 hex chars, hyphens stripped. */
function tsHex(id: string): string {
  return id.replace(/-/g, "").slice(0, 12);
}

describe("uuidv7 (local RFC 9562 implementation)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the RFC 9562 v7 shape (version 7, variant 8/9/a/b)", () => {
    for (let i = 0; i < 1000; i++) {
      const id = uuidv7();
      expect(id).toMatch(UUIDV7_RE);
      // Explicit version nibble + variant nibble checks (belt and suspenders).
      expect(id[14]).toBe("7");
      expect(["8", "9", "a", "b"]).toContain(id[19]);
    }
  });

  it("produces 10,000 unique ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(10_000);
  });

  it("ids generated 1 ms apart sort ascending by timestamp prefix", () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const start = 1_700_000_000_000;
    for (let i = 0; i < 50; i++) {
      vi.setSystemTime(start + i);
      ids.push(uuidv7());
    }
    const prefixes = ids.map(tsHex);
    const sorted = [...prefixes].sort();
    expect(prefixes).toEqual(sorted);
    // And strictly increasing (1 ms steps must change the 48-bit prefix).
    for (let i = 1; i < prefixes.length; i++) {
      expect(prefixes[i]! > prefixes[i - 1]!).toBe(true);
    }
  });

  it("encodes the millisecond timestamp in the first 48 bits", () => {
    vi.useFakeTimers();
    const t = 0x0123456789ab; // arbitrary 48-bit value
    vi.setSystemTime(t);
    const id = uuidv7();
    expect(tsHex(id)).toBe("0123456789ab");
  });
});
