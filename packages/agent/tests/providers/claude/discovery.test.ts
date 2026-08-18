import { describe, expect, it } from "vitest";
import { claudeEffortsFromHelp } from "../../../src/providers/claude/discovery.js";
import {
  CLAUDE_EFFORTS,
  claudeEffortFlagValue,
  claudeEffortFromFlagValue,
} from "../../../src/providers/claude/effort.js";

/** `claude --help` renders the accepted list on a wrapped continuation line. */
const HELP = [
  "Options:",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --environment <environment_id>        Create a new cloud session that runs on",
  "                                        the given self-hosted environment",
  "  --model <model>                       Model for the current session (e.g.",
  "                                        'fable', 'opus', or 'sonnet')",
].join("\n");

describe("Claude effort vocabulary", () => {
  it("renames only the rung Claude spells differently", () => {
    expect(claudeEffortFlagValue("ultra")).toBe("ultracode");
    expect(claudeEffortFlagValue("xhigh")).toBe("xhigh");
    expect(claudeEffortFlagValue("max")).toBe("max");
  });

  it("round-trips the wire value back to the canonical id", () => {
    for (const effort of CLAUDE_EFFORTS) {
      expect(claudeEffortFromFlagValue(claudeEffortFlagValue(effort))).toBe(effort);
    }
  });

  it("leaves an unknown value alone rather than guessing", () => {
    expect(claudeEffortFlagValue("unheard-of")).toBe("unheard-of");
    expect(claudeEffortFromFlagValue("unheard-of")).toBe("unheard-of");
  });
});

describe("claudeEffortsFromHelp", () => {
  it("reads the wrapped list and stops before the next option", () => {
    expect(claudeEffortsFromHelp(HELP)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("does not claim the model option's parenthetical", () => {
    expect(claudeEffortsFromHelp(HELP)).not.toContain("fable");
    expect(claudeEffortsFromHelp(HELP)).not.toContain("opus");
  });

  it("translates a wire value the CLI advertises into the canonical id", () => {
    expect(claudeEffortsFromHelp("  --effort <level>  Effort (low, ultracode)"))
      .toEqual(["low", "ultra"]);
  });

  it("surfaces a value newer than this library, since help is real enumeration", () => {
    expect(claudeEffortsFromHelp("  --effort <level>  Effort (low, unheard-of)"))
      .toEqual(["low", "unheard-of"]);
  });

  it("returns nothing when the option or its list is absent, so probing takes over", () => {
    expect(claudeEffortsFromHelp("Options:\n  --model <model>  Model (opus, sonnet)")).toEqual([]);
    expect(claudeEffortsFromHelp("Options:\n  --effort <level>  Effort level")).toEqual([]);
    expect(claudeEffortsFromHelp("")).toEqual([]);
  });
});
