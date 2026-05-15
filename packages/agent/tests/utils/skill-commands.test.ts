import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildExpandedSkillPrompt,
  commandInventoryFromEvent,
  discoverSkillCommands,
  formatSlashInvocation,
  invokeSkill,
  reconcileSkillCommands,
  type SkillCommandDescriptor,
} from "../../src/utils/skill-commands.js";
import { installSkills } from "../../src/utils/skills.js";
import type { AgentSession, SessionState, StreamEvent, TurnResult } from "../../src/types.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

async function createSkillDir(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-skill-command-"));
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
  tmpDirs.push(root);
  return dir;
}

function completedTurn(summary: string): TurnResult {
  return {
    status: "completed",
    summary,
    costUsd: null,
    errorCode: null,
    errorMessage: null,
  };
}

class FakeSession implements AgentSession {
  messages: string[] = [];
  get sessionId(): string | null { return "session-1"; }
  get state(): SessionState { return "idle"; }
  async send(message: string): Promise<TurnResult> {
    this.messages.push(message);
    return completedTurn(message);
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("commandInventoryFromEvent", () => {
  it("extracts Claude slash commands and skills from typed init events", () => {
    const event: StreamEvent = {
      type: "system",
      subtype: "init",
      model: "claude-test",
      cwd: "/tmp",
      tools: [],
      permissionMode: "default",
      slashCommands: ["help", "code-review"],
      skills: ["code-review"],
      timestamp: "2026-05-15T00:00:00.000Z",
      providerType: "claude",
      sessionId: "session-1",
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: {},
    };

    expect(commandInventoryFromEvent(event)).toMatchObject({
      provider: "claude",
      sessionId: "session-1",
      slashCommands: ["help", "code-review"],
      skills: ["code-review"],
      source: "provider-init",
    });
  });

  it("falls back to raw init event arrays", () => {
    const event: StreamEvent = {
      type: "system",
      subtype: "init",
      model: null,
      cwd: null,
      tools: null,
      permissionMode: null,
      timestamp: "2026-05-15T00:00:00.000Z",
      providerType: "claude",
      sessionId: "session-1",
      messageId: null,
      eventId: null,
      turnId: null,
      parentToolCallId: null,
      raw: { slash_commands: ["review"], skills: ["review"] },
    };

    expect(commandInventoryFromEvent(event)?.skills).toEqual(["review"]);
  });
});

describe("discoverSkillCommands", () => {
  it("discovers v1 metadata from explicit skill dirs", async () => {
    const skillDir = await createSkillDir("code-review", [
      "---",
      "description: Review code changes",
      "argument-hint: <target>",
      "user-invocable: true",
      "---",
      "Read the target and review it.",
    ].join("\n"));

    const result = await discoverSkillCommands({
      skillDirs: [skillDir],
      runtime: "claude",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      name: "code-review",
      description: "Review code changes",
      argumentHint: "<target>",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "provider-slash", provider: "claude", commandText: "/code-review" },
    });
  });

  it("uses expanded-prompt execution for Codex", async () => {
    const skillDir = await createSkillDir("testing", [
      "---",
      "description: Write tests",
      "---",
      "Write focused tests for $ARGUMENTS.",
    ].join("\n"));

    const result = await discoverSkillCommands({
      skillDirs: [skillDir],
      runtime: "codex",
    });

    expect(result.commands[0]?.execution).toEqual({ kind: "expanded-prompt", provider: "codex" });
  });

  it("preserves workspace-installed source provenance", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-installed-skill-cwd-"));
    const skillDir = path.join(cwd, ".agents", "skills", "workspace-review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Review the workspace.");
    tmpDirs.push(cwd);

    const result = await discoverSkillCommands({
      cwd,
      includeInstalled: "workspace",
      runtime: "codex",
    });

    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "workspace-review",
        source: "installed-workspace",
        sourcePath: skillDir,
      }),
    ]);
  });

  it("discovers workspace-installed symlink targets from skill directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-installed-link-cwd-"));
    const skillDir = await createSkillDir("linked-installed", "Review linked installed skills.");
    tmpDirs.push(cwd);
    await installSkills([skillDir], { location: "workspace", cwd });

    const result = await discoverSkillCommands({
      cwd,
      includeInstalled: "workspace",
      runtime: "codex",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "linked-installed",
        source: "installed-workspace",
        sourcePath: skillDir,
      }),
    ]);
  });

  it("deduplicates skill dirs by realpath", async () => {
    const skillDir = await createSkillDir("linked-review", "Review linked files.");
    const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-linked-skill-"));
    const linkDir = path.join(linkRoot, "linked-review-copy");
    await fs.symlink(skillDir, linkDir, "dir");
    tmpDirs.push(linkRoot);

    const result = await discoverSkillCommands({
      skillDirs: [skillDir, linkDir],
      runtime: "claude",
    });

    expect(result.commands).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        path: linkDir,
        message: "Duplicate skill path skipped",
      }),
    ]);
  });

  it("returns diagnostics for missing SKILL.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentex-missing-skill-"));
    const skillDir = path.join(root, "missing");
    await fs.mkdir(skillDir);
    tmpDirs.push(root);

    const result = await discoverSkillCommands({ skillDirs: [skillDir] });

    expect(result.commands).toEqual([]);
    expect(result.diagnostics[0]?.level).toBe("error");
  });
});

describe("reconcileSkillCommands", () => {
  it("marks Claude commands unavailable when absent from runtime inventory", () => {
    const commands: SkillCommandDescriptor[] = [
      {
        id: "claude:review:/tmp/review",
        name: "review",
        source: "configured",
        userInvocable: true,
        available: true,
        execution: { kind: "provider-slash", provider: "claude", commandText: "/review" },
      },
      {
        id: "claude:test:/tmp/test",
        name: "test",
        source: "configured",
        userInvocable: true,
        available: true,
        execution: { kind: "provider-slash", provider: "claude", commandText: "/test" },
      },
    ];

    const reconciled = reconcileSkillCommands({
      discovered: commands,
      provider: "claude",
      inventory: {
        provider: "claude",
        slashCommands: ["review"],
        skills: [],
        source: "provider-init",
      },
    });

    expect(reconciled.map((command) => [command.name, command.available])).toEqual([
      ["review", true],
      ["test", false],
    ]);
  });

  it("does not disable expanded-prompt app commands from Claude inventory", () => {
    const commands: SkillCommandDescriptor[] = [
      {
        id: "app:review",
        name: "review",
        source: "app",
        userInvocable: true,
        available: true,
        execution: { kind: "expanded-prompt", provider: "claude" },
      },
    ];

    const reconciled = reconcileSkillCommands({
      discovered: commands,
      provider: "claude",
      inventory: {
        provider: "claude",
        slashCommands: [],
        skills: [],
        source: "provider-init",
      },
    });

    expect(reconciled[0]?.available).toBe(true);
  });
});

describe("skill invocation helpers", () => {
  it("formats slash invocations", () => {
    expect(formatSlashInvocation({ name: "review" })).toBe("/review");
    expect(formatSlashInvocation({ name: "review" }, "src")).toBe("/review src");
  });

  it("sends raw slash text for Claude provider-slash commands", async () => {
    const session = new FakeSession();
    const command: SkillCommandDescriptor = {
      id: "claude:review:/tmp/review",
      name: "review",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "provider-slash", provider: "claude", commandText: "/review" },
    };

    await invokeSkill(session, command, { provider: "claude", args: "src/app.ts" });

    expect(session.messages).toEqual(["/review src/app.ts"]);
  });

  it("derives provider from provider-slash commands when omitted", async () => {
    const session = new FakeSession();
    const command: SkillCommandDescriptor = {
      id: "codex:review:/tmp/review",
      name: "review",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "provider-slash", provider: "codex", commandText: "/review" },
    };

    await invokeSkill(session, command, { args: "src/app.ts" });

    expect(session.messages).toEqual(["/review src/app.ts"]);
  });

  it("can invoke provider-slash commands without options", async () => {
    const session = new FakeSession();
    const command: SkillCommandDescriptor = {
      id: "claude:review:/tmp/review",
      name: "review",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "provider-slash", provider: "claude", commandText: "/review" },
    };

    await invokeSkill(session, command);

    expect(session.messages).toEqual(["/review"]);
  });


  it("throws when invocation provider conflicts with descriptor provider", async () => {
    const session = new FakeSession();
    const command: SkillCommandDescriptor = {
      id: "codex:review:/tmp/review",
      name: "review",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "expanded-prompt", provider: "codex" },
    };

    await expect(invokeSkill(session, command, { provider: "claude" })).rejects.toThrow(
      'configured for provider "codex", not "claude"',
    );
  });

  it("builds and sends expanded prompts for Codex", async () => {
    const skillDir = await createSkillDir("review", [
      "---",
      "description: Review code",
      "---",
      "Review $ARGUMENTS carefully.",
    ].join("\n"));
    const session = new FakeSession();
    const command: SkillCommandDescriptor = {
      id: "codex:review:test",
      name: "review",
      description: "Review code",
      source: "configured",
      sourcePath: skillDir,
      userInvocable: true,
      available: true,
      execution: { kind: "expanded-prompt", provider: "codex" },
    };

    await invokeSkill(session, command, {
      provider: "codex",
      args: "src/app.ts",
      userRequest: "Focus on regressions.",
    });

    expect(session.messages[0]).toContain("Skill: review");
    expect(session.messages[0]).toContain("Review src/app.ts carefully.");
    expect(session.messages[0]).toContain("Focus on regressions.");
  });

  it("buildExpandedSkillPrompt includes a fallback body", async () => {
    const prompt = await buildExpandedSkillPrompt({
      id: "codex:missing",
      name: "missing",
      source: "configured",
      userInvocable: true,
      available: true,
      execution: { kind: "expanded-prompt", provider: "codex" },
    });

    expect(prompt).toContain("(No skill body was available.)");
  });

  it("substitutes CLAUDE_SKILL_DIR for expanded prompts", async () => {
    const skillDir = await createSkillDir("asset-skill", "Read ${CLAUDE_SKILL_DIR}/reference.md.");
    const prompt = await buildExpandedSkillPrompt({
      id: "codex:asset-skill",
      name: "asset-skill",
      source: "configured",
      sourcePath: skillDir,
      userInvocable: true,
      available: true,
      execution: { kind: "expanded-prompt", provider: "codex" },
    });

    expect(prompt).toContain(`Read ${skillDir}/reference.md.`);
  });
});
