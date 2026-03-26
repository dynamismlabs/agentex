import { describe, it, expect } from "vitest";
import { opencodeSessionCodec } from "../../../src/providers/opencode/codec.js";

describe("opencodeSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = opencodeSessionCodec.deserialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("extracts session_id from snake_case", () => {
      const result = opencodeSessionCodec.deserialize({ session_id: "s2" });
      expect(result).toEqual({ sessionId: "s2" });
    });

    it("extracts sessionID (all caps ID)", () => {
      const result = opencodeSessionCodec.deserialize({ sessionID: "s3" });
      expect(result).toEqual({ sessionId: "s3" });
    });

    it("returns null for null input", () => {
      expect(opencodeSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(opencodeSessionCodec.deserialize(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(opencodeSessionCodec.deserialize("string")).toBeNull();
    });

    it("returns null for array input", () => {
      expect(opencodeSessionCodec.deserialize([1, 2])).toBeNull();
    });

    it("returns null when no session id present", () => {
      expect(opencodeSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId", () => {
      const result = opencodeSessionCodec.serialize({ sessionId: "s1", cwd: "/tmp" });
      expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
    });

    it("reads sessionID and normalizes to sessionId", () => {
      const result = opencodeSessionCodec.serialize({ sessionID: "s3" });
      expect(result).toEqual({ sessionId: "s3" });
    });

    it("returns null for null params", () => {
      expect(opencodeSessionCodec.serialize(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(opencodeSessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    });

    it("serializes without cwd when not present", () => {
      const result = opencodeSessionCodec.serialize({ sessionId: "s1" });
      expect(result).toEqual({ sessionId: "s1" });
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(opencodeSessionCodec.getDisplayId!({ sessionId: "s1" })).toBe("s1");
    });

    it("returns sessionID", () => {
      expect(opencodeSessionCodec.getDisplayId!({ sessionID: "s3" })).toBe("s3");
    });

    it("returns null for null params", () => {
      expect(opencodeSessionCodec.getDisplayId!(null)).toBeNull();
    });

    it("returns null when no session id", () => {
      expect(opencodeSessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("serialize then deserialize preserves data", () => {
      const original = { sessionId: "roundtrip-123", cwd: "/home/test" };
      const serialized = opencodeSessionCodec.serialize(original);
      const deserialized = opencodeSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
