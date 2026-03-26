import { describe, it, expect } from "vitest";
import { piSessionCodec } from "../../../src/providers/pi/codec.js";

describe("piSessionCodec", () => {
  describe("deserialize", () => {
    it("extracts sessionId from camelCase", () => {
      const result = piSessionCodec.deserialize({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        cwd: "/tmp",
      });
      expect(result).toEqual({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        cwd: "/tmp",
      });
    });

    it("extracts session_id from snake_case", () => {
      const result = piSessionCodec.deserialize({
        session_id: "/home/.pi/sessions/2024-sess.jsonl",
      });
      expect(result).toEqual({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
      });
    });

    it("returns null for null input", () => {
      expect(piSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(piSessionCodec.deserialize(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(piSessionCodec.deserialize("string")).toBeNull();
    });

    it("returns null for array input", () => {
      expect(piSessionCodec.deserialize([1, 2])).toBeNull();
    });

    it("returns null when no session id present", () => {
      expect(piSessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("serialize", () => {
    it("serializes params with sessionId", () => {
      const result = piSessionCodec.serialize({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        cwd: "/tmp",
      });
      expect(result).toEqual({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        cwd: "/tmp",
      });
    });

    it("returns null for null params", () => {
      expect(piSessionCodec.serialize(null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(piSessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    });

    it("serializes without cwd when not present", () => {
      const result = piSessionCodec.serialize({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
      });
      expect(result).toEqual({
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
      });
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId", () => {
      expect(
        piSessionCodec.getDisplayId!({
          sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        }),
      ).toBe("/home/.pi/sessions/2024-sess.jsonl");
    });

    it("returns null for null params", () => {
      expect(piSessionCodec.getDisplayId!(null)).toBeNull();
    });

    it("returns null when no session id", () => {
      expect(piSessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
    });
  });

  describe("roundtrip", () => {
    it("serialize then deserialize preserves data", () => {
      const original = {
        sessionId: "/home/.pi/sessions/2024-sess.jsonl",
        cwd: "/home/test",
      };
      const serialized = piSessionCodec.serialize(original);
      const deserialized = piSessionCodec.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});
