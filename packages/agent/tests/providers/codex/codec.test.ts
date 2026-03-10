import { describe, it, expect } from "vitest";
import { codexSessionCodec } from "../../../src/providers/codex/codec.js";

describe("codexSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = codexSessionCodec.deserialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("extracts thread_id", () => {
      const result = codexSessionCodec.deserialize({ thread_id: "t1" });
      expect(result).toEqual({ sessionId: "t1" });
    });

    it("returns null for null input", () => {
      expect(codexSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null when no session id", () => {
      expect(codexSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId", () => {
      const result = codexSessionCodec.serialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("returns null for null params", () => {
      expect(codexSessionCodec.serialize(null)).toBeNull();
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(codexSessionCodec.getDisplayId!({ sessionId: "s1" })).toBe("s1");
    });

    it("returns thread_id", () => {
      expect(codexSessionCodec.getDisplayId!({ thread_id: "t1" })).toBe("t1");
    });

    it("returns null for null params", () => {
      expect(codexSessionCodec.getDisplayId!(null)).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("preserves data through roundtrip", () => {
      const original = { sessionId: "roundtrip-1", cwd: "/work" };
      const serialized = codexSessionCodec.serialize(original);
      const deserialized = codexSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
