import { describe, it, expect } from "vitest";
import {
  SESSION_RECORD_VERSION,
  MalformedSessionRecordError,
  createSessionRecord,
  isSessionRecord,
  assertSessionRecord,
} from "../../src/sessions/index.js";
import type { SessionRecord } from "../../src/index.js";

describe("createSessionRecord", () => {
  it("stamps version + updatedAt and defaults cwd/displayId to null", () => {
    const rec = createSessionRecord({ providerType: "claude", params: { sessionId: "s1" } });
    expect(rec.version).toBe(SESSION_RECORD_VERSION);
    expect(rec.providerType).toBe("claude");
    expect(rec.params).toEqual({ sessionId: "s1" });
    expect(rec.cwd).toBeNull();
    expect(rec.displayId).toBeNull();
    expect(typeof rec.updatedAt).toBe("string");
    expect(() => new Date(rec.updatedAt).toISOString()).not.toThrow();
  });

  it("carries cwd + displayId when provided", () => {
    const rec = createSessionRecord({
      providerType: "codex",
      params: { sessionId: "t1", cwd: "/w" },
      cwd: "/w",
      displayId: "t1",
    });
    expect(rec.cwd).toBe("/w");
    expect(rec.displayId).toBe("t1");
  });

  it("round-trips through assertSessionRecord", () => {
    const rec = createSessionRecord({ providerType: "claude", params: { sessionId: "s1" } });
    const json = JSON.parse(JSON.stringify(rec)) as unknown;
    expect(() => assertSessionRecord(json)).not.toThrow();
    expect(isSessionRecord(json)).toBe(true);
  });
});

describe("isSessionRecord", () => {
  const valid: SessionRecord = {
    version: 1,
    providerType: "claude",
    params: { sessionId: "s1" },
    cwd: "/w",
    displayId: "s1",
    updatedAt: "2026-07-02T00:00:00.000Z",
  };

  it("accepts a valid record", () => {
    expect(isSessionRecord(valid)).toBe(true);
  });

  it("tolerates extra keys (persisted inside a larger row)", () => {
    expect(isSessionRecord({ ...valid, hostRowId: 42, note: "x" })).toBe(true);
  });

  it("accepts null cwd / displayId", () => {
    expect(isSessionRecord({ ...valid, cwd: null, displayId: null })).toBe(true);
  });

  it.each([
    ["not an object", 5],
    ["null", null],
    ["array", []],
    ["wrong version", { ...valid, version: 2 }],
    ["missing providerType", { ...valid, providerType: "" }],
    ["params not object", { ...valid, params: "nope" }],
    ["cwd wrong type", { ...valid, cwd: 5 }],
    ["displayId wrong type", { ...valid, displayId: 5 }],
    ["updatedAt wrong type", { ...valid, updatedAt: 123 }],
  ])("rejects %s", (_label, input) => {
    expect(isSessionRecord(input)).toBe(false);
  });
});

describe("assertSessionRecord", () => {
  const valid: SessionRecord = {
    version: 1,
    providerType: "claude",
    params: { sessionId: "s1" },
    cwd: null,
    displayId: null,
    updatedAt: "2026-07-02T00:00:00.000Z",
  };

  it("passes a valid record", () => {
    expect(() => assertSessionRecord(valid)).not.toThrow();
  });

  it.each([
    ["version", { ...valid, version: 99 }],
    ["providerType", { ...valid, providerType: 5 }],
    ["params", { ...valid, params: null }],
    ["cwd", { ...valid, cwd: 5 }],
    ["displayId", { ...valid, displayId: {} }],
    ["updatedAt", { ...valid, updatedAt: 0 }],
  ])("throws MalformedSessionRecordError naming the offending path: %s", (path, input) => {
    try {
      assertSessionRecord(input);
      throw new Error("expected assertSessionRecord to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedSessionRecordError);
      expect((err as MalformedSessionRecordError).path).toBe(path);
    }
  });

  it("throws with no path for a non-object", () => {
    try {
      assertSessionRecord(42);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedSessionRecordError);
      expect((err as MalformedSessionRecordError).path).toBeUndefined();
    }
  });
});
