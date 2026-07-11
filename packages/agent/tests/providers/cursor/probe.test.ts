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
    expect(report.capabilities.planMode?.supported).toBe(true);
    expect(report.capabilities.modes?.supported).toBe(true);
  });

  it("reports upgrade required when model discovery is absent", async () => {
    const report = await probeCursorCapabilities({ config: { command: MOCK_CURSOR } });

    expect(report.binary.status).toBe("upgrade_required");
    expect(report.capabilities.modelDiscovery?.supported).toBe(false);
  });
});
