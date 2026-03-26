import { describe, it, expect } from "vitest";
import { cursorSessionCodec } from "../../../src/providers/cursor/codec.js";

describe("cursorSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = cursorSessionCodec.deserialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("extracts session_id from snake_case", () => {
      const result = cursorSessionCodec.deserialize({ session_id: "s2" });
      expect(result).toEqual({ sessionId: "s2" });
    });

    it("returns null for null input", () => {
      expect(cursorSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(cursorSessionCodec.deserialize(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(cursorSessionCodec.deserialize("string")).toBeNull();
    });

    it("returns null for array input", () => {
      expect(cursorSessionCodec.deserialize([1, 2])).toBeNull();
    });

    it("returns null when no session id present", () => {
      expect(cursorSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });

    it("returns null for empty sessionId", () => {
      expect(cursorSessionCodec.deserialize({ sessionId: "" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId", () => {
      const result = cursorSessionCodec.serialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("returns null for null params", () => {
      expect(cursorSessionCodec.serialize(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(cursorSessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    });

    it("serializes without cwd when not present", () => {
      const result = cursorSessionCodec.serialize({ sessionId: "s1" });
      expect(result).toEqual({ sessionId: "s1" });
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(cursorSessionCodec.getDisplayId!({ sessionId: "s1" })).toBe("s1");
    });

    it("returns null for null params", () => {
      expect(cursorSessionCodec.getDisplayId!(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(cursorSessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("serialize then deserialize preserves data", () => {
      const original = { sessionId: "roundtrip-123", cwd: "/home/test" };
      const serialized = cursorSessionCodec.serialize(original);
      const deserialized = cursorSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
