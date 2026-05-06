import { describe, it, expect } from "vitest";
import {
  CODEX_PLAN_MODE_PREAMBLE,
  withPlanModePreamble,
} from "../../../src/providers/codex/plan-mode.js";

describe("withPlanModePreamble", () => {
  it("returns the preamble alone when no instructions are provided", () => {
    expect(withPlanModePreamble(null)).toBe(CODEX_PLAN_MODE_PREAMBLE);
  });

  it("returns the preamble alone when instructions are empty", () => {
    expect(withPlanModePreamble("")).toBe(CODEX_PLAN_MODE_PREAMBLE);
  });

  it("prepends the preamble before existing instructions", () => {
    const result = withPlanModePreamble("# Custom\nDo X");
    expect(result.startsWith(CODEX_PLAN_MODE_PREAMBLE)).toBe(true);
    expect(result.endsWith("# Custom\nDo X")).toBe(true);
    expect(result).toContain("\n\n");
  });

  it("preamble explicitly tells the agent not to attempt edits", () => {
    expect(CODEX_PLAN_MODE_PREAMBLE).toMatch(/do not attempt edits/i);
  });
});
