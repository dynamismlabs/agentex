import { describe, it, expect } from "vitest";
import { renderTemplate, resolvePathValue } from "../../src/utils/template.js";

describe("resolvePathValue", () => {
  it("resolves a top-level key", () => {
    expect(resolvePathValue({ name: "world" }, "name")).toBe("world");
  });

  it("resolves nested dot path", () => {
    expect(resolvePathValue({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("returns undefined for missing path", () => {
    expect(resolvePathValue({}, "missing")).toBeUndefined();
  });

  it("returns undefined for path through non-object", () => {
    expect(resolvePathValue({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(resolvePathValue(null, "a")).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  it("replaces a simple variable", () => {
    expect(renderTemplate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("replaces nested path variable", () => {
    expect(renderTemplate("{{a.b.c}}", { a: { b: { c: "deep" } } })).toBe("deep");
  });

  it("replaces missing path with empty string", () => {
    expect(renderTemplate("Hello {{missing}}", {})).toBe("Hello ");
  });

  it("replaces null value with empty string", () => {
    expect(renderTemplate("{{val}}", { val: null })).toBe("");
  });

  it("replaces undefined value with empty string", () => {
    expect(renderTemplate("{{val}}", { val: undefined })).toBe("");
  });

  it("handles multiple variables", () => {
    expect(renderTemplate("{{a}} and {{b}}", { a: "X", b: "Y" })).toBe("X and Y");
  });

  it("passes through template with no variables", () => {
    expect(renderTemplate("no vars here", {})).toBe("no vars here");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", {})).toBe("");
  });

  it("trims whitespace in variable name", () => {
    expect(renderTemplate("{{ name }}", { name: "trimmed" })).toBe("trimmed");
  });

  it("handles numeric values", () => {
    expect(renderTemplate("count: {{n}}", { n: 42 })).toBe("count: 42");
  });

  it("handles boolean values", () => {
    expect(renderTemplate("{{flag}}", { flag: true })).toBe("true");
  });
});
