import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeCursorCapabilities } from "../../../src/providers/cursor/probe.js";

const MOCK_CURSOR = path.resolve(import.meta.dirname, "../../fixtures/mock-cursor.sh");

describe("Cursor runtime capability probe", () => {
  it("reports a supported feature profile from successful probes", async () => {
    const report = await probeCursorCapabilities({
      config: { command: MOCK_CURSOR },
      env: { MOCK_CURSOR_PROFILE: "supported" },
    });

    expect(report.binary.status).toBe("supported");
    expect(report.binary.version).toBe("2.0.0");
    expect(report.capabilities.modelDiscovery?.supported).toBe(true);
    expect(report.capabilities.sessions?.supported).toBe(true);
    expect(report.capabilities.sessions?.reason).toBeUndefined();
    expect(report.capabilities.resume?.supported).toBe(true);
    expect(report.capabilities.planMode?.supported).toBe(true);
    expect(report.capabilities.modes?.supported).toBe(true);
  });

  it("does not claim sessions when discovery works but required protocol flags are absent", async () => {
    const report = await probeCursorCapabilities({
      config: { command: MOCK_CURSOR },
      env: { MOCK_CURSOR_PROFILE: "models_only" },
    });

    expect(report.binary.status).toBe("upgrade_required");
    expect(report.binary.protocolProfile).toBeNull();
    expect(report.capabilities.modelDiscovery?.supported).toBe(true);
    expect(report.capabilities.sessions?.supported).toBe(false);
    expect(report.capabilities.resume?.supported).toBe(false);
  });

  it("does not infer stream-json from a generic output-format flag", async () => {
    const report = await probeCursorCapabilities({
      config: { command: MOCK_CURSOR },
      env: { MOCK_CURSOR_PROFILE: "no_stream_json" },
    });
    expect(report.capabilities.modelDiscovery?.supported).toBe(true);
    expect(report.capabilities.sessions?.supported).toBe(false);
    expect(report.binary.protocolProfile).toBeNull();
  });

  it("reports upgrade required when model discovery is absent", async () => {
    const report = await probeCursorCapabilities({ config: { command: MOCK_CURSOR } });

    expect(report.binary.status).toBe("upgrade_required");
    expect(report.capabilities.modelDiscovery?.supported).toBe(false);
  });
});
