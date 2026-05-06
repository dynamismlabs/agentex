import { describe, it, expect } from "vitest";
import { parseExitPlanMode } from "../../src/utils/exit-plan-mode.js";
import type { UserInputRequest } from "../../src/types.js";

function makeReq(overrides: Partial<UserInputRequest>): UserInputRequest {
  return {
    toolName: "ExitPlanMode",
    input: {},
    toolUseId: "toolu_test",
    ...overrides,
  };
}

describe("parseExitPlanMode", () => {
  it("extracts the plan string from an ExitPlanMode request", () => {
    const req = makeReq({
      input: { plan: "## Steps\n1. Foo\n2. Bar" },
    });
    const result = parseExitPlanMode(req);
    expect(result).toEqual({ plan: "## Steps\n1. Foo\n2. Bar" });
  });

  it("returns null for non-ExitPlanMode tools", () => {
    const req = makeReq({ toolName: "Bash", input: { command: "ls" } });
    expect(parseExitPlanMode(req)).toBeNull();
  });

  it("returns null when input has no plan field", () => {
    const req = makeReq({ input: {} });
    expect(parseExitPlanMode(req)).toBeNull();
  });

  it("returns null when plan is not a string", () => {
    const req = makeReq({ input: { plan: 42 } });
    expect(parseExitPlanMode(req)).toBeNull();
  });

  it("preserves an empty plan string (intentional empty plan)", () => {
    const req = makeReq({ input: { plan: "" } });
    expect(parseExitPlanMode(req)).toEqual({ plan: "" });
  });
});
