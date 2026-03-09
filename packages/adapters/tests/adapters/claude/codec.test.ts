import { describe, it, expect } from "vitest";
import { claudeSessionCodec } from "../../../src/adapters/claude/codec.js";

describe("claudeSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = claudeSessionCodec.deserialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("extracts session_id from snake_case", () => {
      const result = claudeSessionCodec.deserialize({ session_id: "s2" });
      expect(result).toEqual({ sessionId: "s2" });
    });

    it("extracts cwd from workdir alias", () => {
      const result = claudeSessionCodec.deserialize({ sessionId: "s3", workdir: "/work" });
      expect(result).toEqual({ sessionId: "s3", cwd: "/work" });
    });

    it("extracts cwd from folder alias", () => {
      const result = claudeSessionCodec.deserialize({ sessionId: "s4", folder: "/fold" });
      expect(result).toEqual({ sessionId: "s4", cwd: "/fold" });
    });

    it("returns null for null input", () => {
      expect(claudeSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(claudeSessionCodec.deserialize(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(claudeSessionCodec.deserialize("string")).toBeNull();
    });

    it("returns null for array input", () => {
      expect(claudeSessionCodec.deserialize([1, 2])).toBeNull();
    });

    it("returns null when no sessionId present", () => {
      expect(claudeSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });

    it("returns null for empty sessionId", () => {
      expect(claudeSessionCodec.deserialize({ sessionId: "" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId", () => {
      const result = claudeSessionCodec.serialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("returns null for null params", () => {
      expect(claudeSessionCodec.serialize(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(claudeSessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    });

    it("serializes without cwd when not present", () => {
      const result = claudeSessionCodec.serialize({ sessionId: "s1" });
      expect(result).toEqual({ sessionId: "s1" });
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(claudeSessionCodec.getDisplayId!({ sessionId: "s1" })).toBe("s1");
    });

    it("returns null for null params", () => {
      expect(claudeSessionCodec.getDisplayId!(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(claudeSessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("serialize then deserialize preserves data", () => {
      const original = { sessionId: "roundtrip-123", cwd: "/home/test" };
      const serialized = claudeSessionCodec.serialize(original);
      const deserialized = claudeSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
