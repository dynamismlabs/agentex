import { describe, it, expect } from "vitest";
import { chunkMessage } from "../../src/channels/chunker.js";

describe("chunkMessage", () => {
  it("returns single chunk when text fits", () => {
    const result = chunkMessage("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  it("returns empty string chunk for empty text", () => {
    const result = chunkMessage("", 100);
    expect(result).toEqual([""]);
  });

  it("splits at paragraph boundaries", () => {
    const text = "paragraph one\n\nparagraph two\n\nparagraph three";
    const result = chunkMessage(text, 25);

    // Each paragraph should fit in its own chunk
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(25);
      expect(chunk.length).toBeGreaterThan(0);
    }

    // Joining with \n\n should reconstruct the original
    expect(result.join("\n\n")).toBe(text);
  });

  it("splits long paragraphs at line boundaries", () => {
    const text = "line one\nline two\nline three\nline four";
    const result = chunkMessage(text, 20);

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("force-splits a single long line at maxLength", () => {
    const text = "a".repeat(50);
    const result = chunkMessage(text, 20);

    expect(result).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(10)]);
    expect(result.join("")).toBe(text);
  });

  it("handles exact boundary", () => {
    const text = "exact";
    const result = chunkMessage(text, 5);
    expect(result).toEqual(["exact"]);
  });

  it("never produces empty chunks", () => {
    const text = "a\n\nb\n\nc";
    const result = chunkMessage(text, 3);

    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("preserves code blocks across chunks", () => {
    const text = "before\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nafter";
    const result = chunkMessage(text, 30);

    // Check that no chunk leaves an unclosed code fence
    for (const chunk of result) {
      const fenceCount = (chunk.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("closes and reopens code fences when a code block spans chunks", () => {
    // Create a scenario where a code block definitely spans multiple chunks
    const code = "```python\n" + "x = 1\n".repeat(10) + "```";
    const result = chunkMessage(code, 30);

    expect(result.length).toBeGreaterThan(1);

    // Every chunk should have balanced fences
    for (const chunk of result) {
      const fenceCount = (chunk.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("throws on non-positive maxLength", () => {
    expect(() => chunkMessage("hello", 0)).toThrow("maxLength must be positive");
    expect(() => chunkMessage("hello", -1)).toThrow("maxLength must be positive");
  });
});
