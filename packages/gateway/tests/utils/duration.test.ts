import { describe, it, expect } from "vitest";
import { parseDuration } from "../../src/utils/duration.js";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("120s")).toBe(120_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  it("parses hours", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
  });

  it("parses days", () => {
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("parses with whitespace", () => {
    expect(parseDuration("  10s  ")).toBe(10_000);
  });

  it("parses uppercase units", () => {
    expect(parseDuration("5H")).toBe(18_000_000);
  });

  it("parses decimal values", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  it("throws on missing unit", () => {
    expect(() => parseDuration("100")).toThrow("Invalid duration");
  });

  it("throws on invalid unit", () => {
    expect(() => parseDuration("10x")).toThrow("Invalid duration");
  });
});
