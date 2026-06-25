import { describe, it, expect } from "vitest";
import type { TurnResult } from "../../src/index.js";
import { createDefaultSentinel, parseAssessment } from "../../src/index.js";

function turn(summary: string | null): TurnResult {
  return { summary, costUsd: null, status: "completed", errorCode: null, errorMessage: null };
}

describe("parseAssessment", () => {
  it("affirmative first tokens → met", () => {
    expect(parseAssessment("YES")).toBe(true);
    expect(parseAssessment("yes, fully done")).toBe(true);
    expect(parseAssessment("Complete.")).toBe(true);
    expect(parseAssessment("done")).toBe(true);
    expect(parseAssessment("the goal is met")).toBe(true);
  });

  it("negative or ambiguous → not met (conservative)", () => {
    expect(parseAssessment("NO")).toBe(false);
    expect(parseAssessment("not yet")).toBe(false);
    expect(parseAssessment("not met")).toBe(false);
    expect(parseAssessment("the goal is not complete")).toBe(false);
    expect(parseAssessment("")).toBe(false);
    expect(parseAssessment("maybe, hard to say")).toBe(false);
  });
});

describe("createDefaultSentinel", () => {
  it("returns met when the meta-turn answers YES", async () => {
    const sentinel = createDefaultSentinel({ metaSend: async () => turn("YES, the tests pass") });
    const verdict = await sentinel({ objective: "tests pass", lastTurn: turn("x"), transcriptPath: null, iterations: 0 });
    expect(verdict).toEqual({ met: true });
  });

  it("returns not-met when the meta-turn answers NO", async () => {
    const sentinel = createDefaultSentinel({ metaSend: async () => turn("No — two tests still fail") });
    const verdict = await sentinel({ objective: "tests pass", lastTurn: turn("x"), transcriptPath: null, iterations: 1 });
    expect(verdict).toEqual({ met: false });
  });

  it("passes the objective into the assessment prompt", async () => {
    let seen = "";
    const sentinel = createDefaultSentinel({
      metaSend: async (msg) => { seen = msg; return turn("YES"); },
    });
    await sentinel({ objective: "ship the auth fix", lastTurn: turn("x"), transcriptPath: null, iterations: 0 });
    expect(seen).toContain("ship the auth fix");
  });
});
