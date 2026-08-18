import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every `--effort` argument must go through the vocabulary mapper.
 *
 * This is a source-level invariant rather than a behavioral test because both
 * call sites build their args inside a spawn path, and the failure it guards
 * is specifically the one that is invisible at run time: `claude --effort
 * ultra` warns on stderr and then runs the turn at the session default, so a
 * new call site pushing `config.effort` raw would pass every functional test
 * while silently ignoring the caller's choice.
 */
const SOURCES = ["../../../src/providers/claude/session.ts", "../../../src/providers/claude/execute.ts"];

/** Effort arguments pushed onto an argv array, in source order. */
export function effortArguments(source: string): string[] {
  return [...source.matchAll(/"--effort",\s*([^)]+)\)/g)].map((match) => (match[1] ?? "").trim());
}

const translated = (argument: string) => argument.startsWith("claudeEffortFlagValue(");

describe("Claude --effort wire values", () => {
  it("recognizes a raw push as untranslated", () => {
    // Polarity check: the shapes this guard exists to reject and accept, so a
    // regex that quietly stops matching cannot pass by finding nothing.
    expect(effortArguments('args.push("--effort", config.effort);')).toEqual(["config.effort"]);
    expect(effortArguments('args.push("--effort", config.effort);').every(translated)).toBe(false);
    expect(effortArguments('args.push("--effort", claudeEffortFlagValue(config.effort));')
      .every(translated)).toBe(true);
  });

  it("never pushes a raw effort value onto the command line", () => {
    for (const relative of SOURCES) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      const pushes = effortArguments(source);
      expect(pushes.length, `${relative} should still push --effort`).toBeGreaterThan(0);
      for (const argument of pushes) {
        expect(translated(argument), `${relative} pushes an untranslated effort: ${argument}`).toBe(true);
      }
    }
  });
});
