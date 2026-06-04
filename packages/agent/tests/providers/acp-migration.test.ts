import { describe, it, expect } from "vitest";
import { getProvider, listProviders } from "../../src/index.js";

describe("gemini + copilot are ACP-backed providers", () => {
  for (const id of ["gemini", "copilot"]) {
    it(`${id} declares ACP session capabilities`, () => {
      const p = getProvider(id);
      expect(p.type).toBe(id);
      expect(p.capabilities.sessions).toBe(true);
      expect(p.capabilities.modes).toBe(true);
      expect(p.capabilities.dynamicCapabilities).toBe(true);
      expect(p.capabilities.planMode).toBe(false);
      expect(p.capabilities.concurrentSend).toBe(false);
      expect(p.createSession).toBeDefined();
      expect(p.listModes).toBeDefined();
    });
  }

  it("copilot is registered (the ACP tier makes a 6th provider ~5 lines)", () => {
    expect(listProviders()).toContain("copilot");
  });

  it("gemini keeps its richer auth reporting (api_key / oauth options), not the generic ACP binary check", async () => {
    const report = await getProvider("gemini").resolveAuth({ env: { GEMINI_API_KEY: "x" } });
    expect(report.providerType).toBe("gemini");
    expect(report.options.length).toBeGreaterThan(0);
  });

  // Real-agent validation — opt in with AGENTEX_REAL_GEMINI_ACP=1 (needs an
  // authed `gemini` CLI on PATH).
  it.skipIf(process.env.AGENTEX_REAL_GEMINI_ACP !== "1")(
    "runs a real `gemini --acp` turn end-to-end",
    async () => {
      const session = await getProvider("gemini").createSession!({});
      const turn = await (await session.send("Reply with the single word: pong")).result;
      await session.close();
      expect(["completed", "failed"]).toContain(turn.status);
      expect(session.state).toBe("closed");
    },
    60_000,
  );
});
