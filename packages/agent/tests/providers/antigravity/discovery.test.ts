import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAntigravityModels,
  listAntigravityModes,
  parseAntigravityModels,
} from "../../../src/providers/antigravity/discovery.js";
import { probeAntigravityCapabilities } from "../../../src/providers/antigravity/probe.js";
import { antigravitySessionCodec } from "../../../src/providers/antigravity/codec.js";
import { buildAgyArgs, readAgyResumeId, resolveAgyMode } from "../../../src/providers/antigravity/runtime.js";
import { clearModelCache } from "../../../src/utils/model-cache.js";

const MOCK_AGY = path.resolve(import.meta.dirname, "../../fixtures/mock-agy.sh");

afterEach(() => clearModelCache("antigravity"));

describe("parseAntigravityModels", () => {
  it("parses the documented `agy models` text table", () => {
    // From https://antigravity.google/docs/cli/headless ("Select a model, effort, or agent").
    const output = [
      "gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
      "gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
      "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
      "...",
    ].join("\n");
    expect(parseAntigravityModels(output)).toEqual([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("ignores progress lines, markers, and duplicates", () => {
    const output = "Fetching available models...\n* gemini-3.1-pro-high   Gemini 3.1 Pro (High) (current)\ngemini-3.1-pro-high  dup\n";
    expect(parseAntigravityModels(output)).toEqual([{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" }]);
  });

  it("accepts a JSON catalog when a build prints one", () => {
    expect(parseAntigravityModels(JSON.stringify({ models: [{ slug: "gemini-x", display_name: "Gemini X" }, "bare-model"] }))).toEqual([
      { id: "gemini-x", name: "Gemini X" },
      { id: "bare-model", name: "bare-model" },
    ]);
    expect(parseAntigravityModels("")).toEqual([]);
  });
});

describe("listAntigravityModels", () => {
  it("falls back to the text form when `models --output-format json` is unsupported", async () => {
    const models = await listAntigravityModels({ config: { command: MOCK_AGY } });
    expect(models.map((m) => m.id)).toEqual(["gemini-3.8-flash-high", "gemini-3.1-pro-high", "claude-sonnet-4-6"]);
  });

  it("explains a missing sign-in instead of returning an empty catalog", async () => {
    await expect(
      listAntigravityModels({ config: { command: MOCK_AGY }, env: { MOCK_AGY_AUTH: "missing" } }),
    ).rejects.toThrow(/not signed in.*agy/);
  });
});

describe("listAntigravityModes", () => {
  it("returns the CLI's three execution modes without spawning", async () => {
    const modes = await listAntigravityModes({ config: { command: "/nonexistent/agy" } });
    expect(modes.map((m) => m.id)).toEqual(["default", "accept-edits", "plan"]);
  });
});

describe("probeAntigravityCapabilities", () => {
  it("reports a supported binary with model discovery", async () => {
    const report = await probeAntigravityCapabilities({ config: { command: MOCK_AGY } });
    expect(report.binary).toMatchObject({ status: "supported", version: "1.2.14", protocolProfile: "agy-stream-json-v1" });
    expect(report.capabilities.sessions?.supported).toBe(true);
    expect(report.capabilities.modelDiscovery?.supported).toBe(true);
    expect(report.capabilities.sessionModelChange?.supported).toBe(false);
  });

  it("asks for an update when the CLI predates stream-json input", async () => {
    const report = await probeAntigravityCapabilities({ config: { command: MOCK_AGY }, env: { MOCK_AGY_HELP: "old" } });
    expect(report.binary.status).toBe("upgrade_required");
    expect(report.binary.reason).toMatch(/agy update.*--input-format/);
    expect(report.capabilities.sessions?.supported).toBe(false);
  });

  it("reports model discovery as unavailable until sign-in", async () => {
    const report = await probeAntigravityCapabilities({ config: { command: MOCK_AGY }, env: { MOCK_AGY_AUTH: "missing" } });
    expect(report.binary.status).toBe("supported");
    expect(report.capabilities.modelDiscovery).toMatchObject({ supported: false, status: "missing", reason: expect.stringMatching(/not signed in/) });
  });

  it("reports a missing binary", async () => {
    const report = await probeAntigravityCapabilities({ config: { command: "/nonexistent/agy" } });
    expect(report.binary.status).toBe("missing");
  });
});

describe("antigravitySessionCodec", () => {
  it("round-trips the conversation id and cwd", () => {
    const params = antigravitySessionCodec.serialize({ sessionId: " conv-1 ", cwd: "/repo" });
    expect(params).toEqual({ sessionId: "conv-1", cwd: "/repo" });
    expect(antigravitySessionCodec.deserialize(params)).toEqual(params);
    expect(antigravitySessionCodec.getDisplayId?.(params)).toBe("conv-1");
  });

  it("accepts snake_case and conversationId aliases and rejects junk", () => {
    expect(antigravitySessionCodec.deserialize({ session_id: "a" })).toEqual({ sessionId: "a" });
    expect(antigravitySessionCodec.deserialize({ conversationId: "b" })).toEqual({ sessionId: "b" });
    expect(antigravitySessionCodec.deserialize({ sessionId: "" })).toBeNull();
    expect(antigravitySessionCodec.deserialize(null)).toBeNull();
    expect(antigravitySessionCodec.deserialize(["x"])).toBeNull();
    expect(antigravitySessionCodec.getDisplayId?.(null)).toBeNull();
  });
});

describe("agy argument helpers", () => {
  it("resolves the mode flag", () => {
    expect(resolveAgyMode({})).toBeNull();
    expect(resolveAgyMode({ modeId: "default" })).toBeNull();
    expect(resolveAgyMode({ modeId: "accept-edits" })).toBe("accept-edits");
    expect(resolveAgyMode({ mode: "plan" })).toBe("plan");
    expect(resolveAgyMode({ planMode: true, modeId: "accept-edits" })).toBe("plan");
  });

  it("never pairs plan mode with skipped permissions, however plan was requested", () => {
    for (const config of [{ planMode: true }, { modeId: "plan" }, { mode: "plan" }]) {
      const args = buildAgyArgs({ ...config, skipPermissions: true }, { resumeId: null, model: null });
      expect(args).toEqual(expect.arrayContaining(["--mode", "plan"]));
      expect(args).not.toContain("--dangerously-skip-permissions");
    }
    expect(buildAgyArgs({ modeId: "accept-edits", skipPermissions: true }, { resumeId: null, model: null }))
      .toContain("--dangerously-skip-permissions");
  });

  it("passes no --mode for default, which agy rejects as a flag value", () => {
    expect(buildAgyArgs({ modeId: "default" }, { resumeId: null, model: null })).not.toContain("--mode");
  });

  it("builds stream-json args with resume", () => {
    expect(buildAgyArgs({}, { resumeId: "c1", model: null })).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "c1",
    ]);
  });

  it("only resumes a conversation saved for the same directory", () => {
    expect(readAgyResumeId({ sessionId: "c1", cwd: "/repo" }, "/repo")).toBe("c1");
    expect(readAgyResumeId({ sessionId: "c1", cwd: "/repo/" }, "/repo")).toBe("c1");
    expect(readAgyResumeId({ sessionId: "c1" }, "/anywhere")).toBe("c1");
    expect(readAgyResumeId({ sessionId: "c1", cwd: "/other" }, "/repo")).toBeNull();
    expect(readAgyResumeId({ sessionId: "  " }, "/repo")).toBeNull();
    expect(readAgyResumeId(null, "/repo")).toBeNull();
  });
});
