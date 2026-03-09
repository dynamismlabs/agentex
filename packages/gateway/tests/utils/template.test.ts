import { describe, it, expect } from "vitest";
import { renderGatewayTemplate } from "../../src/utils/template.js";

describe("renderGatewayTemplate", () => {
  it("replaces simple variables", () => {
    expect(renderGatewayTemplate("Hello {{name}}", { name: "Alice" })).toBe(
      "Hello Alice",
    );
  });

  it("replaces dotted path variables", () => {
    expect(
      renderGatewayTemplate("From {{sender.name}}", {
        sender: { name: "Bob" },
      }),
    ).toBe("From Bob");
  });

  it("replaces missing variables with empty string", () => {
    expect(renderGatewayTemplate("Hi {{missing}}", {})).toBe("Hi ");
  });

  it("handles multiple variables", () => {
    expect(
      renderGatewayTemplate("{{a}} and {{b}}", { a: "X", b: "Y" }),
    ).toBe("X and Y");
  });

  it("handles numeric values", () => {
    expect(renderGatewayTemplate("Count: {{n}}", { n: 42 })).toBe(
      "Count: 42",
    );
  });

  it("includes conditional block when variable is truthy", () => {
    expect(
      renderGatewayTemplate("{{#if show}}visible{{/if}}", { show: true }),
    ).toBe("visible");
  });

  it("excludes conditional block when variable is falsy", () => {
    expect(
      renderGatewayTemplate("{{#if show}}visible{{/if}}", { show: false }),
    ).toBe("");
  });

  it("excludes conditional block when variable is missing", () => {
    expect(renderGatewayTemplate("{{#if show}}visible{{/if}}", {})).toBe("");
  });

  it("handles conditional block with content around it", () => {
    expect(
      renderGatewayTemplate("A{{#if x}}B{{/if}}C", { x: "yes" }),
    ).toBe("ABC");
  });

  it("handles conditional with dotted path", () => {
    expect(
      renderGatewayTemplate("{{#if msg.threadId}}Thread: {{msg.threadId}}{{/if}}", {
        msg: { threadId: "t123" },
      }),
    ).toBe("Thread: t123");
  });

  it("handles nested conditionals", () => {
    const template = "{{#if a}}A{{#if b}}B{{/if}}{{/if}}";
    expect(renderGatewayTemplate(template, { a: true, b: true })).toBe("AB");
    expect(renderGatewayTemplate(template, { a: true, b: false })).toBe("A");
    expect(renderGatewayTemplate(template, { a: false, b: true })).toBe("");
  });

  it("handles empty template", () => {
    expect(renderGatewayTemplate("", {})).toBe("");
  });

  it("handles template with no variables", () => {
    expect(renderGatewayTemplate("plain text", {})).toBe("plain text");
  });

  it("handles null in path", () => {
    expect(
      renderGatewayTemplate("{{a.b}}", { a: null }),
    ).toBe("");
  });
});
