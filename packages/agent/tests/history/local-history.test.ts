import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getProvider, type LocalHistorySession, type LocalHistoryYield } from "../../src/index.js";
import { sourceFingerprint } from "../../src/history/fs.js";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_SIDECHAIN_ID = "11111111-1111-4111-8111-222222222222";
const CLAUDE_EMPTY_ID = "11111111-1111-4111-8111-333333333333";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_SUBAGENT_ID = "22222222-2222-4222-8222-333333333333";
const LEGACY_CODEX_ID = "22222222-2222-4222-8222-444444444444";
const CURRENT_CODEX_ID = "22222222-2222-4222-8222-555555555555";

async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("provider local history", () => {
  let root: string;
  let claudeHome: string;
  let codexHome: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agentex-local-history-"));
    claudeHome = path.join(root, "claude");
    codexHome = path.join(root, "codex");
    project = path.join(root, "project");
    await mkdir(project, { recursive: true });

    const claudeDir = path.join(claudeHome, "projects", "-project");
    await writeJsonl(path.join(claudeDir, `${CLAUDE_ID}.jsonl`), [
      {
        type: "user",
        uuid: "claude-user-1",
        session_id: CLAUDE_ID,
        cwd: project,
        gitBranch: "feature/import",
        timestamp: "2026-01-01T10:00:00.000Z",
        isSidechain: false,
        message: { role: "user", content: "Build history import" },
      },
      { type: "ai-title", aiTitle: "History import", timestamp: "2026-01-01T10:00:00.100Z" },
      {
        type: "assistant",
        uuid: "claude-assistant-1",
        session_id: CLAUDE_ID,
        cwd: project,
        timestamp: "2026-01-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "package.json" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "claude-tool-1",
        session_id: CLAUDE_ID,
        cwd: project,
        timestamp: "2026-01-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "{}" }],
        },
      },
    ]);
    await writeJsonl(path.join(claudeDir, `${CLAUDE_SIDECHAIN_ID}.jsonl`), [{
      type: "user",
      uuid: "sidechain-user",
      session_id: CLAUDE_SIDECHAIN_ID,
      cwd: project,
      isSidechain: true,
      message: { role: "user", content: "hidden" },
    }]);
    await writeJsonl(path.join(claudeDir, `${CLAUDE_EMPTY_ID}.jsonl`), [{
      type: "system",
      uuid: "empty-system",
      session_id: CLAUDE_EMPTY_ID,
      cwd: project,
      timestamp: "2026-01-01T09:00:00.000Z",
    }]);
    await writeJsonl(path.join(
      claudeDir,
      CLAUDE_ID,
      "subagents",
      "agent-a1b2c3.jsonl",
    ), [{
      type: "user",
      uuid: "nested-user",
      agentId: "a1b2c3",
      isSidechain: true,
      timestamp: "2026-01-01T10:00:01.500Z",
      message: { role: "user", content: "Inspect the import subsystem" },
    }]);

    const codexFile = path.join(
      codexHome,
      "sessions",
      "2026",
      "01",
      "02",
      `rollout-2026-01-02T11-00-00-${CODEX_ID}.jsonl`,
    );
    await writeJsonl(codexFile, [
      {
        timestamp: "2026-01-02T11:00:00.000Z",
        type: "session_meta",
        payload: {
          id: CODEX_ID,
          cwd: project,
          timestamp: "2026-01-02T11:00:00.000Z",
          git: { branch: "feature/codex", repository_url: "git@example.test:project.git" },
        },
      },
      {
        timestamp: "2026-01-02T11:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Add Codex history" },
      },
      {
        timestamp: "2026-01-02T11:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Codex history is ready." }],
        },
      },
      {
        timestamp: "2026-01-02T11:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "Done" },
      },
    ]);
    await writeJsonl(path.join(
      codexHome,
      "sessions",
      "2026",
      "01",
      "02",
      `rollout-2026-01-02T12-00-00-${CODEX_SUBAGENT_ID}.jsonl`,
    ), [{
      timestamp: "2026-01-02T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: CODEX_SUBAGENT_ID,
        cwd: project,
        parent_thread_id: CODEX_ID,
        thread_source: "subagent",
        source: { subagent: { other: "guardian" } },
      },
    }, {
      timestamp: "2026-01-02T12:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hidden" },
    }]);
    await writeJsonl(path.join(codexHome, "session_index.jsonl"), [{
      id: CODEX_ID,
      thread_name: "Codex history title",
      updated_at: "2026-01-02T11:00:03.000Z",
    }]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("probes Claude without parsing eligibility and discovers only main human sessions", async () => {
    const history = getProvider("claude").localHistory!;
    const probe = await history.probe({ env: { CLAUDE_CONFIG_DIR: claudeHome } });
    expect(probe).toMatchObject({
      providerType: "claude",
      homeAvailable: true,
      historyAvailable: true,
      approximateCount: 3,
    });

    const sessions = await collect(history.discover({ env: { CLAUDE_CONFIG_DIR: claudeHome } }));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      providerType: "claude",
      externalSessionId: CLAUDE_ID,
      cwd: project,
      title: "History import",
      branch: "feature/import",
      hasUserMessage: true,
    });
  });

  it("reads Claude events with stable identities and leaves the source untouched", async () => {
    const history = getProvider("claude").localHistory!;
    const [session] = await collect(history.discover({ env: { CLAUDE_CONFIG_DIR: claudeHome } }));
    const sourceBefore = await readFile(session!.transcriptPath);
    const first = await collect(history.read(session!));
    const second = await collect(history.read(session!));
    expect(first.map((value) => value.event.type)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(first.map(identity)).toEqual(second.map(identity));
    expect(first[1]!.event.eventId).toBe("claude-assistant-1");
    expect(first[2]!.event.eventId).toBe("claude-assistant-1");
    expect(first[1]!.partIndex).toBe(0);
    expect(first[2]!.partIndex).toBe(1);
    expect(await readFile(session!.transcriptPath)).toEqual(sourceBefore);
    expect((await history.fingerprint(session!, { sha256: true })).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes nested Claude subagents only when mainSessionsOnly is false", async () => {
    const history = getProvider("claude").localHistory!;
    const defaultSessions = await collect(history.discover({ env: { CLAUDE_CONFIG_DIR: claudeHome } }));
    expect(defaultSessions).toHaveLength(1);

    const allHumanSessions = await collect(history.discover({
      env: { CLAUDE_CONFIG_DIR: claudeHome },
      mainSessionsOnly: false,
    }));
    const nested = allHumanSessions.find((session) => session.externalSessionId === `subagent:${CLAUDE_ID}:agent-a1b2c3`);
    expect(nested).toMatchObject({
      cwd: project,
      branch: "feature/import",
      hasUserMessage: true,
    });
    expect(allHumanSessions).toHaveLength(3);
  });

  it("discovers Codex main sessions and preserves deterministic file event ids", async () => {
    const history = getProvider("codex").localHistory!;
    const probe = await history.probe({ env: { CODEX_HOME: codexHome } });
    expect(probe).toMatchObject({ homeAvailable: true, historyAvailable: true, approximateCount: 2 });

    const sessions = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      externalSessionId: CODEX_ID,
      title: "Codex history title",
      branch: "feature/codex",
      gitOriginUrl: "git@example.test:project.git",
      archiveState: "active",
    });
    const first = await collect(history.read(sessions[0]!));
    const second = await collect(history.read(sessions[0]!));
    expect(first.map((value) => value.event.type)).toEqual(["user", "assistant", "result"]);
    expect(first.map(identity)).toEqual(second.map(identity));
    expect(first.every((value) => value.event.eventId.startsWith(`codex:${CODEX_ID}:`))).toBe(true);
    expect(first[1]!.event).toMatchObject({ type: "assistant", phase: "final_answer" });
  });

  it("resumes local reads only after a committed source-line boundary", async () => {
    const history = getProvider("codex").localHistory!;
    const [session] = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    const all = await collect(history.read(session!));
    const resumed = await collect(history.read(session!, { fromOffset: all[0]!.nextOffset }));
    expect(resumed.map(identity)).toEqual(all.slice(1).map(identity));
  });

  it("rejects a strong fingerprint assembled across a source mutation", async () => {
    const history = getProvider("claude").localHistory!;
    const [session] = await collect(history.discover({ env: { CLAUDE_CONFIG_DIR: claudeHome } }));
    await expect(sourceFingerprint(session!.transcriptPath, true, {
      afterInitialStat: () => appendFile(session!.transcriptPath, "{}\n"),
    })).rejects.toMatchObject({ code: "source_changed_during_read" });
  });

  it("reports source_changed_during_read when a transcript grows mid-read", async () => {
    const history = getProvider("codex").localHistory!;
    const [session] = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    const iterator = history.read(session!)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await appendFile(session!.transcriptPath, `${JSON.stringify({
      timestamp: "2026-01-02T11:00:04.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "changed" },
    })}\n`);
    await expect(drain(iterator)).rejects.toMatchObject({ code: "source_changed_during_read" });
  });

  it("finds and reads current Codex rollouts, which record user messages as completed items", async () => {
    // Paginated rollouts (Codex 0.142+): no event_msg user_message. The
    // person's words arrive as an item_completed UserMessage, mirrored by a
    // response_item that can also carry injected context. Shell work is an
    // `exec` custom tool call whose output is a list of content parts.
    await writeJsonl(path.join(
      codexHome,
      "sessions",
      "2026",
      "07",
      "07",
      `rollout-2026-07-07T08-44-33-${CURRENT_CODEX_ID}.jsonl`,
    ), [
      {
        timestamp: "2026-07-07T08:44:33.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: CURRENT_CODEX_ID,
          cwd: project,
          originator: "Codex Desktop",
          source: "vscode",
          cli_version: "0.153.4",
          history_mode: "paginated",
        },
      },
      {
        timestamp: "2026-07-07T08:44:34.000Z",
        ordinal: 1,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `<environment_context><cwd>${project}</cwd></environment_context>` }],
        },
      },
      {
        timestamp: "2026-07-07T08:44:35.000Z",
        ordinal: 2,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login redirect" }] },
      },
      {
        timestamp: "2026-07-07T08:44:35.000Z",
        ordinal: 3,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "Fix the login redirect", text_elements: [] }] },
        },
      },
      {
        timestamp: "2026-07-07T08:44:36.000Z",
        ordinal: 4,
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "ctc_1",
          status: "completed",
          call_id: "call_exec",
          name: "exec",
          input: "const r = await tools.exec_command({ cmd: \"rg redirect\" });\ntext(r.output);",
        },
      },
      {
        timestamp: "2026-07-07T08:44:37.000Z",
        ordinal: 5,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "CommandExecution", id: "cmd-1", command: "rg redirect", aggregated_output: "src/login.ts:4" },
        },
      },
      {
        timestamp: "2026-07-07T08:44:37.000Z",
        ordinal: 6,
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          id: "ctco_1",
          call_id: "call_exec",
          output: [
            { type: "input_text", text: "Script completed\nOutput:\n" },
            { type: "input_text", text: "src/login.ts:4" },
          ],
        },
      },
      {
        timestamp: "2026-07-07T08:44:40.000Z",
        ordinal: 7,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "The redirect is fixed." }],
        },
      },
      {
        timestamp: "2026-07-07T08:44:40.000Z",
        ordinal: 8,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "AgentMessage", id: "msg-1", content: [{ type: "Text", text: "The redirect is fixed." }], phase: "final_answer" },
        },
      },
      {
        timestamp: "2026-07-07T08:44:41.000Z",
        ordinal: 9,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "The redirect is fixed.", duration_ms: 8000 },
      },
    ]);

    const history = getProvider("codex").localHistory!;
    const sessions = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    const current = sessions.find((session) => session.externalSessionId === CURRENT_CODEX_ID)!;
    expect(current).toBeDefined();
    expect(current.cwd).toBe(project);
    expect(current.hasUserMessage).toBe(true);
    expect(current.title).toBe("Fix the login redirect");
    const events = await collect(history.read(current));
    expect(events.map((value) => value.event.type)).toEqual(["user", "tool_call", "tool_result", "assistant", "result"]);
    expect(events[0]!.event).toMatchObject({ type: "user", text: "Fix the login redirect" });
    expect(events[1]!.event).toMatchObject({ type: "tool_call", toolCallId: "call_exec", name: "exec" });
    expect(events[2]!.event).toMatchObject({
      type: "tool_result",
      toolCallId: "call_exec",
      content: "Script completed\nOutput:\nsrc/login.ts:4",
    });
    expect(events[4]!.event).toMatchObject({ type: "result", isError: false, terminalReason: "completed", durationMs: 8000 });
  });

  it("reads Codex records containing U+2028 and resumes from their offsets", async () => {
    // serde_json writes U+2028 raw. node:readline used to split the record in
    // two, dropping the message and shifting every later offset.
    const pasted = "Ship this\u2028copied from a web page";
    const rolloutPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "07",
      "08",
      `rollout-2026-07-08T08-00-00-${CURRENT_CODEX_ID}.jsonl`,
    );
    await writeJsonl(rolloutPath, [
      { timestamp: "2026-07-08T08:00:00.000Z", type: "session_meta", payload: { id: CURRENT_CODEX_ID, cwd: project, history_mode: "paginated" } },
      {
        timestamp: "2026-07-08T08:00:01.000Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: pasted }] } },
      },
      {
        timestamp: "2026-07-08T08:00:02.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Shipped." }] },
      },
    ]);
    const bytes = await readFile(rolloutPath);
    expect(bytes.toString("utf8")).toContain("\u2028");

    const history = getProvider("codex").localHistory!;
    const sessions = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    const session = sessions.find((value) => value.externalSessionId === CURRENT_CODEX_ID);
    expect(session).toBeDefined();
    const events = await collect(history.read(session!));
    expect(events.map((value) => value.event.type)).toEqual(["user", "assistant"]);
    expect(events[0]!.event).toMatchObject({ type: "user", text: pasted });
    expect(events[1]!.nextOffset).toBe(bytes.length);

    const resumed = await collect(history.read(session!, { fromOffset: events[0]!.nextOffset }));
    expect(resumed.map((value) => value.event.type)).toEqual(["assistant"]);
    expect(resumed[0]!.lineStartOffset).toBe(events[1]!.lineStartOffset);
  });

  it("preserves assistant and tool activity from legacy Codex rollouts", async () => {
    const legacyPath = path.join(
      codexHome,
      "sessions",
      "2025",
      "10",
      "29",
      `rollout-2025-10-29T14-34-12-${LEGACY_CODEX_ID}.jsonl`,
    );
    await writeJsonl(legacyPath, [
      { id: LEGACY_CODEX_ID, timestamp: "2025-10-29T14:34:12.000Z" },
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `<environment_context><cwd>${project}</cwd></environment_context>`,
        }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the legacy tool flow" }],
      },
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I will read the file." }],
      },
      {
        type: "function_call",
        call_id: "legacy-call",
        name: "read_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
      {
        type: "function_call_output",
        call_id: "legacy-call",
        output: "{}",
        exit_code: 0,
      },
    ]);

    const history = getProvider("codex").localHistory!;
    const sessions = await collect(history.discover({ env: { CODEX_HOME: codexHome } }));
    const legacy = sessions.find((session) => session.externalSessionId === LEGACY_CODEX_ID)!;
    expect(legacy.startedAt).toBe("2025-10-29T14:34:12.000Z");
    const events = await collect(history.read(legacy));
    expect(events.map((value) => value.event.type)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
    ]);
    expect(events[1]!.event).toMatchObject({ type: "assistant", phase: "commentary" });
    expect(events[2]!.event).toMatchObject({
      type: "tool_call",
      toolCallId: "legacy-call",
      name: "read_file",
      input: { path: "package.json" },
    });
    expect(events[3]!.event).toMatchObject({
      type: "tool_result",
      toolCallId: "legacy-call",
      content: "{}",
      exitCode: 0,
    });
  });
});

function identity(value: LocalHistoryYield): string {
  return `${value.event.eventId}:${value.partIndex}:${value.lineStartOffset}:${value.nextOffset}`;
}

async function drain<T>(iterator: AsyncIterator<T>): Promise<void> {
  while (!(await iterator.next()).done) {
    // Drain through the snapshot verification performed at EOF.
  }
}

// Compile-time assertion that discovery descriptors are the public type.
const _sessionType: LocalHistorySession | null = null;
void _sessionType;
