import { describe, it, expect } from "vitest";
import {
  parseCollaborationModes,
  toAgentModes,
  resolveCollaborationModeParam,
  listCodexModes,
} from "../../../src/providers/codex/modes.js";

describe("parseCollaborationModes", () => {
  it("maps the collaborationMode/list data array", () => {
    const modes = parseCollaborationModes({
      data: [
        { name: "Auto", mode: "code", model: "gpt-5.4", reasoning_effort: "medium" },
        { name: "Plan", mode: "plan", developer_instructions: "Investigate only." },
      ],
    });
    expect(modes).toHaveLength(2);
    expect(modes[0]).toEqual({
      name: "Auto",
      mode: "code",
      model: "gpt-5.4",
      reasoning_effort: "medium",
      developer_instructions: null,
    });
    expect(modes[1]!.mode).toBe("plan");
    expect(modes[1]!.developer_instructions).toBe("Investigate only.");
  });

  it("drops entries without a name and tolerates a non-array/object", () => {
    expect(
      parseCollaborationModes({ data: [{ mode: "x" }, null, 5, { name: "Ok", mode: "ok" }] }),
    ).toEqual([{ name: "Ok", mode: "ok", model: null, reasoning_effort: null, developer_instructions: null }]);
    expect(parseCollaborationModes(null)).toEqual([]);
    expect(parseCollaborationModes({ data: "nope" })).toEqual([]);
  });
});

describe("toAgentModes", () => {
  it("uses mode as id, name as label, developer_instructions as description", () => {
    expect(
      toAgentModes([
        { name: "Plan", mode: "plan", model: null, reasoning_effort: null, developer_instructions: "Read only." },
      ]),
    ).toEqual([{ id: "plan", name: "Plan", description: "Read only." }]);
  });

  it("falls back to name when mode is null and omits empty description", () => {
    expect(
      toAgentModes([
        { name: "Custom", mode: null, model: null, reasoning_effort: null, developer_instructions: null },
      ]),
    ).toEqual([{ id: "Custom", name: "Custom" }]);
  });
});

describe("resolveCollaborationModeParam", () => {
  const modes = [
    { name: "Auto", mode: "code", model: "gpt-5.4", reasoning_effort: "medium", developer_instructions: null },
    { name: "Plan", mode: "plan", model: null, reasoning_effort: null, developer_instructions: "Investigate." },
  ];

  it("resolves by mode id and carries the mode's settings", () => {
    expect(resolveCollaborationModeParam(modes, "code")).toEqual({
      mode: "code",
      settings: { model: "gpt-5.4", reasoning_effort: "medium" },
    });
  });

  it("resolves by name as a fallback", () => {
    expect(resolveCollaborationModeParam(modes, "Plan")).toEqual({
      mode: "plan",
      settings: { developer_instructions: "Investigate." },
    });
  });

  it("returns null for an unknown id", () => {
    expect(resolveCollaborationModeParam(modes, "nope")).toBeNull();
  });
});

// Real-binary discovery — opt in with AGENTEX_REAL_CODEX_MODES=1 (needs codex on PATH).
describe("listCodexModes (real binary)", () => {
  it.skipIf(process.env.AGENTEX_REAL_CODEX_MODES !== "1")(
    "discovers collaboration modes from a live codex app-server",
    async () => {
      const modes = await listCodexModes();
      expect(Array.isArray(modes)).toBe(true);
      for (const m of modes) {
        expect(typeof m.id).toBe("string");
        expect(typeof m.name).toBe("string");
      }
    },
  );
});
