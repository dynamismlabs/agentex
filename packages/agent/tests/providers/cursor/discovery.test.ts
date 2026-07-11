import { describe, expect, it } from "vitest";
import { cursorModesFromHelp, parseCursorModels } from "../../../src/providers/cursor/discovery.js";

describe("Cursor discovery", () => {
  it("parses machine-readable model catalogs without special-casing Grok", () => {
    expect(parseCursorModels(JSON.stringify({ models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "grok-4.5", name: "Grok 4.5" },
      "claude-sonnet-4",
    ] }))).toEqual([
      { id: "gpt-5", name: "GPT-5" },
      { id: "grok-4.5", name: "Grok 4.5" },
      { id: "claude-sonnet-4", name: "claude-sonnet-4" },
    ]);
  });

  it("parses the bounded text fallback and deduplicates models", () => {
    expect(parseCursorModels("Models:\n- gpt-5  GPT 5\n- grok-4.5  Grok 4.5\n- gpt-5  duplicate"))
      .toEqual([
        { id: "gpt-5", name: "GPT 5" },
        { id: "grok-4.5", name: "Grok 4.5" },
      ]);
  });

  it("exposes only modes the help profile supports", () => {
    expect(cursorModesFromHelp("Options:\n  --mode <agent|plan>").map((mode) => mode.id))
      .toEqual(["agent", "plan"]);
    expect(cursorModesFromHelp("Options:\n  --mode <mode>  One of agent, plan, ask").map((mode) => mode.id))
      .toEqual(["agent", "plan", "ask"]);
    expect(cursorModesFromHelp("Options:\n  --mode <mode>")).toEqual([]);
    expect(cursorModesFromHelp("Options:\n  --model <model>")).toEqual([]);
  });
});
