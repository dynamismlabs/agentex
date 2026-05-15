import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  commandInventoryFromEvent,
  discoverSkillCommands,
  getProvider,
  invokeSkill,
  reconcileSkillCommands,
  type RuntimeCommandInventory,
} from "../../src/index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

async function createSmokeSkill(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-claude-skill-smoke-"));
  const skillDir = path.join(root, "agentex-skill-smoke");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "description: AgentEx slash skill smoke test",
    "argument-hint: <ignored>",
    "---",
    "Reply with exactly this string and nothing else: AGENTEX_SKILL_SMOKE_OK",
  ].join("\n"));
  tmpDirs.push(root);
  return skillDir;
}

describe("Claude skill slash smoke", () => {
  it.skipIf(process.env.AGENTEX_REAL_CLAUDE_SKILL_SMOKE !== "1")(
    "round-trips a discovered skill through a real Claude Code session",
    async () => {
      const provider = getProvider("claude");
      if (!provider.createSession) throw new Error("Claude provider does not support sessions");

      const skillDir = await createSmokeSkill();
      let inventory: RuntimeCommandInventory | null = null;
      const session = await provider.createSession({
        config: {
          skillDirs: [skillDir],
          skipPermissions: true,
          maxTurns: 1,
          timeoutSec: 60,
        },
        onEvent: (event) => {
          inventory ??= commandInventoryFromEvent(event);
        },
      });

      try {
        const discovered = await discoverSkillCommands({
          skillDirs: [skillDir],
          runtime: "claude",
        });
        expect(discovered.diagnostics).toEqual([]);

        const command = discovered.commands[0];
        expect(command).toBeDefined();

        const result = await invokeSkill(session, command!, {
          provider: "claude",
          args: "ignore",
        });

        const runtimeNames = new Set([
          ...(inventory?.skills ?? []),
          ...(inventory?.slashCommands ?? []),
        ]);
        expect(runtimeNames.has("agentex-skill-smoke")).toBe(true);
        expect(reconcileSkillCommands({
          discovered: discovered.commands,
          inventory,
          provider: "claude",
        })[0]?.available).toBe(true);
        expect(result.summary).toContain("AGENTEX_SKILL_SMOKE_OK");
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
