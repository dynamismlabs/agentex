import { describe, it, expect } from "vitest";
import { geminiSessionCodec } from "../../../src/providers/gemini/codec.js";

describe("geminiSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = geminiSessionCodec.deserialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("extracts session_id from snake_case", () => {
      const result = geminiSessionCodec.deserialize({ session_id: "s2" });
      expect(result).toEqual({ sessionId: "s2" });
    });

    it("extracts checkpoint_id", () => {
      const result = geminiSessionCodec.deserialize({ checkpoint_id: "chk-1" });
      expect(result).toEqual({ sessionId: "chk-1" });
    });

    it("returns null for null input", () => {
      expect(geminiSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(geminiSessionCodec.deserialize(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(geminiSessionCodec.deserialize("string")).toBeNull();
    });

    it("returns null for array input", () => {
      expect(geminiSessionCodec.deserialize([1, 2])).toBeNull();
    });

    it("returns null when no session id present", () => {
      expect(geminiSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });

    it("returns null for empty sessionId", () => {
      expect(geminiSessionCodec.deserialize({ sessionId: "" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId and cwd", () => {
      const result = geminiSessionCodec.serialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("reads checkpoint_id and normalizes to sessionId", () => {
      const result = geminiSessionCodec.serialize({ checkpoint_id: "chk-1" });
      expect(result).toEqual({ sessionId: "chk-1" });
    });

    it("returns null for null params", () => {
      expect(geminiSessionCodec.serialize(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(geminiSessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    });

    it("serializes without cwd when not present", () => {
      const result = geminiSessionCodec.serialize({ sessionId: "s1" });
      expect(result).toEqual({ sessionId: "s1" });
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(geminiSessionCodec.getDisplayId!({ sessionId: "s1" })).toBe("s1");
    });

    it("returns checkpoint_id", () => {
      expect(geminiSessionCodec.getDisplayId!({ checkpoint_id: "chk-1" })).toBe("chk-1");
    });

    it("returns null for null params", () => {
      expect(geminiSessionCodec.getDisplayId!(null)).toBeNull();
    });

    it("returns null when no session id", () => {
      expect(geminiSessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("serialize then deserialize preserves data", () => {
      const original = { sessionId: "roundtrip-123", cwd: "/home/test" };
      const serialized = geminiSessionCodec.serialize(original);
      const deserialized = geminiSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
