// ---------------------------------------------------------------------------
// Agent Board – Agent execution, console buffers, session resume
// ---------------------------------------------------------------------------

import { getProvider, parseAskUserQuestion } from "../../packages/agent/src/index.js";
import type { StreamEvent, ExecutionResult, AgentSession, UserInputRequest, UserInputResponse } from "../../packages/agent/src/index.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import process from "node:process";
import {
  readState,
  updateTask,
  updateAgent,
  addNotification,
  addActivity,
  appendTaskActivity,
  ensureWorkspace,
  DATA_DIR,
} from "./store.js";
import type { SSEEvent, AgentQuestion } from "./types.js";

// ---------------------------------------------------------------------------
// PID tracking – persist child process PIDs so we can verify liveness on restart
// ---------------------------------------------------------------------------

const PID_FILE = join(DATA_DIR, "pids.json");

function readPids(): Record<string, number> {
  try {
    if (existsSync(PID_FILE)) return JSON.parse(readFileSync(PID_FILE, "utf-8"));
  } catch { /* corrupt file */ }
  return {};
}

function writePids(pids: Record<string, number>): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

export function setAgentPid(agentId: string, pid: number): void {
  const pids = readPids();
  pids[agentId] = pid;
  writePids(pids);
}

export function clearAgentPid(agentId: string): void {
  const pids = readPids();
  delete pids[agentId];
  writePids(pids);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

export function getAgentPids(): Record<string, number> {
  return readPids();
}

// ---------------------------------------------------------------------------
// Git snapshot – commit workspace state before agent runs so we can diff later
// ---------------------------------------------------------------------------

function snapshotWorkspace(cwd: string): void {
  try {
    if (!existsSync(join(cwd, ".git"))) {
      execSync("git init", { cwd, stdio: "ignore" });
      execSync("git config user.email agent-board@local", { cwd, stdio: "ignore" });
      execSync("git config user.name agent-board", { cwd, stdio: "ignore" });
    }
    // Stage and commit everything as the baseline
    execSync("git add -A", { cwd, stdio: "ignore" });
    // --allow-empty in case workspace is empty or nothing changed since last snapshot
    execSync('git commit --allow-empty -m "snapshot before agent run"', { cwd, stdio: "ignore" });
  } catch {
    // Non-fatal — diff just won't work
  }
}

// ---------------------------------------------------------------------------
// File tracking — extract modified file paths from agent tool_call events
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function extractFilePath(event: StreamEvent): string | null {
  if (event.type !== "tool_call" || !FILE_TOOLS.has(event.name)) return null;
  const input = event.input as Record<string, unknown> | null;
  if (!input) return null;
  const fp = input.file_path ?? input.path;
  return typeof fp === "string" ? fp : null;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const DEMO_SKILL_DIRS = [
  join(__dirname, "skills", "code-review"),
  join(__dirname, "skills", "testing"),
  join(__dirname, "skills", "security"),
  join(__dirname, "skills", "test-interactive"),
];

const MAX_BUFFER = 500;

// ---------------------------------------------------------------------------
// Pending AskUserQuestion — waiting for UI answers
// ---------------------------------------------------------------------------

interface PendingQuestion {
  resolve: (answers: Record<string, string>) => void;
  question: AgentQuestion;
}

const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * Called by the server when the UI answers a question.
 * Returns true if the requestId was found and resolved.
 */
export function resolveQuestion(requestId: string, answers: Record<string, string>): boolean {
  const pending = pendingQuestions.get(requestId);
  if (!pending) return false;
  const { question } = pending;
  pendingQuestions.delete(requestId);
  pending.resolve(answers);
  broadcast({ type: "agent_question_answered", requestId });

  // Show the user's answers in the console feed
  const summary = Object.entries(answers)
    .map(([q, a]) => `${q}: ${a}`)
    .join("\n");
  const answerEvent: StreamEvent = {
    type: "assistant",
    text: `[you] ${summary}`,
    timestamp: new Date().toISOString(),
  };
  pushBuffer(question.agentId, answerEvent);
  broadcast({ type: "agent_output", agentId: question.agentId, event: answerEvent });

  return true;
}

/** Get all pending questions (for initial page load). */
export function getPendingQuestions(): AgentQuestion[] {
  return Array.from(pendingQuestions.values()).map((p) => p.question);
}

/**
 * Build an onUserInputRequest callback for a given agent/task.
 * AskUserQuestion → broadcast to UI, wait for answer.
 * Regular tools → auto-allow.
 */
function makeUserInputHandler(agentId: string, taskId: string | null): (req: UserInputRequest) => Promise<UserInputResponse> {
  return async (req: UserInputRequest): Promise<UserInputResponse> => {
    const questions = parseAskUserQuestion(req);
    if (questions) {
      const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const agentQuestion: AgentQuestion = {
        requestId,
        agentId,
        taskId,
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiSelect: q.multiSelect,
        })),
        createdAt: new Date().toISOString(),
      };

      // Wait for UI to answer
      const answersPromise = new Promise<Record<string, string>>((resolve) => {
        pendingQuestions.set(requestId, { resolve, question: agentQuestion });
      });

      // Broadcast to all SSE clients
      broadcast({ type: "agent_question", question: agentQuestion });

      const answers = await answersPromise;
      return { allow: true, updatedInput: { ...req.input, answers } };
    }

    // Regular tool — auto-allow
    return { allow: true };
  };
}

/** Console output buffers per agent */
export const consoleBuffers = new Map<string, StreamEvent[]>();

/** Broadcast callback — set by server.ts */
let broadcastFn: ((event: SSEEvent) => void) | null = null;

export function setBroadcast(fn: (event: SSEEvent) => void): void {
  broadcastFn = fn;
}

function broadcast(event: SSEEvent): void {
  broadcastFn?.(event);
}

function pushBuffer(agentId: string, event: StreamEvent): void {
  let buf = consoleBuffers.get(agentId);
  if (!buf) {
    buf = [];
    consoleBuffers.set(agentId, buf);
  }
  buf.push(event);
  if (buf.length > MAX_BUFFER) buf.shift();
}

// ---------------------------------------------------------------------------
// Persistent sessions (session mode) — one AgentSession per agent
// ---------------------------------------------------------------------------

const agentSessions = new Map<string, AgentSession>();

/**
 * Get or create a persistent session for an agent.
 * Returns null if the provider doesn't support createSession.
 */
async function getOrCreateSession(
  agentId: string,
  cwd: string,
): Promise<AgentSession | null> {
  // Reuse existing live session
  const existing = agentSessions.get(agentId);
  if (existing && existing.state !== "closed") return existing;

  const provider = getProvider("claude");
  if (!provider.createSession) return null;

  const state = readState();
  const agent = state.agents.find((a) => a.id === agentId);

  // Determine the current task for this agent (for question context)
  const currentTaskId = agent?.currentTaskId ?? null;

  console.log(`[session] creating new session for agent=${agentId} cwd=${cwd}`);
  const session = await provider.createSession({
    cwd,
    sessionParams: agent?.sessionParams ?? undefined,
    config: {
      maxTurns: state.settings.maxTurns,
      timeoutSec: state.settings.timeoutSec,
      model: state.settings.model,
      skillDirs: DEMO_SKILL_DIRS,
    },
    onEvent: (event: StreamEvent) => {
      pushBuffer(agentId, event);
      broadcast({ type: "agent_output", agentId, event });
    },
    onUserInputRequest: makeUserInputHandler(agentId, currentTaskId),
  });

  agentSessions.set(agentId, session);
  console.log(`[session] session created for agent=${agentId} sessionId=${session.sessionId}`);
  return session;
}

/** Close and remove the persistent session for an agent. */
export async function closeAgentSession(agentId: string): Promise<void> {
  const session = agentSessions.get(agentId);
  if (session) {
    agentSessions.delete(agentId);
    try { await session.close(); } catch { /* best-effort */ }
  }
}

/** Close all persistent sessions (server shutdown / reconciliation). */
export async function closeAllSessions(): Promise<void> {
  const ids = [...agentSessions.keys()];
  await Promise.allSettled(ids.map((id) => closeAgentSession(id)));
}

// ---------------------------------------------------------------------------
// Execute a task
// ---------------------------------------------------------------------------

export async function executeTask(agentId: string, taskId: string): Promise<void> {
  const state = readState();
  const agent = state.agents.find((a) => a.id === agentId);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!agent || !task) return;

  const cwd = ensureWorkspace(taskId);
  snapshotWorkspace(cwd);
  const prompt = `Task: ${task.title}\n\nDetails: ${task.description}`;

  // Clear console buffer for new task
  consoleBuffers.set(agentId, []);

  // Show the task prompt in console so the user can see what was sent
  const promptEvent: StreamEvent = {
    type: "system",
    subtype: `task: ${task.title}`,
    sessionId: null,
    model: null,
    timestamp: new Date().toISOString(),
  };
  pushBuffer(agentId, promptEvent);
  broadcast({ type: "agent_output", agentId, event: promptEvent });

  // Update agent status
  updateAgent(agentId, { status: "working", currentTaskId: taskId, lastActiveAt: new Date().toISOString() });
  broadcast({ type: "agent_status", agentId, status: "working", taskId });

  // Append activity to task markdown
  appendTaskActivity(taskId, agent.name, "Claimed", "Starting work on this task.");

  // Log activity
  addActivity({ type: "task_claimed", agentId, taskId, message: `${agent.name} claimed "${task.title}"` });

  const useSession = state.settings.executionMode === "session";
  console.log(`[execute] agent=${agent.name} task="${task.title}" mode=${useSession ? "session" : "one-shot"}`);

  if (useSession) {
    await executeTaskSession(agentId, taskId, cwd, prompt, agent, task);
  } else {
    await executeTaskOneShot(agentId, taskId, cwd, prompt, agent, task);
  }
}

// ---------------------------------------------------------------------------
// Execute task — one-shot (execute mode)
// ---------------------------------------------------------------------------

async function executeTaskOneShot(
  agentId: string,
  taskId: string,
  cwd: string,
  prompt: string,
  agent: { name: string; totalRuns: number; totalCostUsd: number },
  task: { title: string },
): Promise<void> {
  const state = readState();
  const provider = getProvider("claude");
  const startTime = Date.now();
  const modifiedFiles = new Set<string>();

  try {
    console.log(`[one-shot] starting provider.execute() for agent=${agent.name}`);
    const result: ExecutionResult = await provider.execute({
      prompt,
      cwd,
      config: {
        skipPermissions: true,
        maxTurns: state.settings.maxTurns,
        timeoutSec: state.settings.timeoutSec,
        model: state.settings.model,
        skillDirs: DEMO_SKILL_DIRS,
      },
      onStart: (pid) => setAgentPid(agentId, pid),
      onEvent: (event: StreamEvent) => {
        pushBuffer(agentId, event);
        broadcast({ type: "agent_output", agentId, event });
        const fp = extractFilePath(event);
        if (fp) modifiedFiles.add(fp);
      },
    });

    clearAgentPid(agentId);
    const success = result.exitCode === 0;
    const durationMs = result.durationMs || (Date.now() - startTime);
    const costUsd = result.costUsd ?? 0;
    console.log(`[one-shot] finished agent=${agent.name} exit=${result.exitCode} duration=${(durationMs / 1000).toFixed(1)}s cost=$${costUsd.toFixed(4)} model=${result.model}`);

    // Update task
    const updatedTask = updateTask(taskId, {
      status: success ? "review" : "failed",
      completedAt: result.completedAt || new Date().toISOString(),
      modifiedFiles: Array.from(modifiedFiles),
      result: {
        exitCode: result.exitCode,
        summary: result.summary,
        costUsd: result.costUsd,
        model: result.model,
        errorMessage: result.errorMessage,
        durationMs,
        usage: result.usage ?? null,
      },
    });

    // Append completion to markdown
    const statusLabel = success ? "Completed" : "Failed";
    const summary = result.summary || (success ? "Task completed successfully." : result.errorMessage || "Task failed.");
    appendTaskActivity(taskId, agent.name, statusLabel, `${summary}\n\n**Result:** ${statusLabel} | Duration: ${(durationMs / 1000).toFixed(1)}s | Cost: $${costUsd.toFixed(4)}`);

    // Update agent
    updateAgent(agentId, {
      status: "idle",
      currentTaskId: null,
      sessionParams: result.sessionParams ?? null,
      totalRuns: agent.totalRuns + 1,
      totalCostUsd: agent.totalCostUsd + costUsd,
      lastActiveAt: new Date().toISOString(),
    });

    // Notification + activity
    const notifType = success ? "task_completed" as const : "task_failed" as const;
    addNotification({ type: notifType, agentId, taskId, message: `${agent.name} ${success ? "completed" : "failed"}: "${task.title}"` });
    addActivity({ type: success ? "task_completed" : "task_failed", agentId, taskId, message: `${agent.name} ${success ? "completed" : "failed"} "${task.title}"` });

    // Broadcast updates
    if (updatedTask) broadcast({ type: "task_update", task: updatedTask });
    broadcast({ type: "agent_status", agentId, status: "idle", taskId: null, sessionParams: result.sessionParams ?? null });

    // Handle pending message
    const refreshedAgent = readState().agents.find((a) => a.id === agentId);
    if (refreshedAgent?.pendingMessage) {
      const msg = refreshedAgent.pendingMessage;
      updateAgent(agentId, { pendingMessage: null });
      sendMessage(agentId, msg);
    }
  } catch (err: unknown) {
    clearAgentPid(agentId);
    handleTaskError(agentId, taskId, agent, task, err, Date.now() - startTime);
  }
}

// ---------------------------------------------------------------------------
// Execute task — session mode (persistent process)
// ---------------------------------------------------------------------------

async function executeTaskSession(
  agentId: string,
  taskId: string,
  cwd: string,
  prompt: string,
  agent: { name: string; totalRuns: number; totalCostUsd: number },
  task: { title: string },
): Promise<void> {
  const startTime = Date.now();

  try {
    console.log(`[session] getting/creating session for agent=${agent.name}`);
    const session = await getOrCreateSession(agentId, cwd);
    if (!session) {
      console.log(`[session] createSession not available, falling back to one-shot`);
      await executeTaskOneShot(agentId, taskId, cwd, prompt, agent, task);
      return;
    }
    console.log(`[session] sending turn via session.send() sessionId=${session.sessionId}`);

    const result = await session.send(prompt);
    const durationMs = Date.now() - startTime;
    const success = !result.isError;
    const costUsd = result.costUsd ?? 0;
    console.log(`[session] turn complete agent=${agent.name} success=${success} duration=${(durationMs / 1000).toFixed(1)}s cost=$${costUsd.toFixed(4)} stopReason=${result.stopReason}`);

    // Update task
    const updatedTask = updateTask(taskId, {
      status: success ? "review" : "failed",
      completedAt: new Date().toISOString(),
      modifiedFiles: [],
      result: {
        exitCode: success ? 0 : 1,
        summary: result.summary,
        costUsd: result.costUsd,
        model: null,
        errorMessage: result.errorMessage,
        durationMs,
        usage: result.usage ?? null,
      },
    });

    // Append completion to markdown
    const statusLabel = success ? "Completed" : "Failed";
    const summary = result.summary || (success ? "Task completed successfully." : result.errorMessage || "Task failed.");
    appendTaskActivity(taskId, agent.name, statusLabel, `${summary}\n\n**Result:** ${statusLabel} | Duration: ${(durationMs / 1000).toFixed(1)}s | Cost: $${costUsd.toFixed(4)}`);

    // Update agent — session stays alive, persist sessionId for display
    updateAgent(agentId, {
      status: "idle",
      currentTaskId: null,
      sessionParams: session.sessionId ? { sessionId: session.sessionId, cwd } : null,
      totalRuns: agent.totalRuns + 1,
      totalCostUsd: agent.totalCostUsd + costUsd,
      lastActiveAt: new Date().toISOString(),
    });

    // Notification + activity
    const notifType = success ? "task_completed" as const : "task_failed" as const;
    addNotification({ type: notifType, agentId, taskId, message: `${agent.name} ${success ? "completed" : "failed"}: "${task.title}"` });
    addActivity({ type: success ? "task_completed" : "task_failed", agentId, taskId, message: `${agent.name} ${success ? "completed" : "failed"} "${task.title}"` });

    // Broadcast updates
    if (updatedTask) broadcast({ type: "task_update", task: updatedTask });
    broadcast({ type: "agent_status", agentId, status: "idle", taskId: null });

    // Handle pending message
    const refreshedAgent = readState().agents.find((a) => a.id === agentId);
    if (refreshedAgent?.pendingMessage) {
      const msg = refreshedAgent.pendingMessage;
      updateAgent(agentId, { pendingMessage: null });
      sendMessage(agentId, msg);
    }
  } catch (err: unknown) {
    // If session died, remove it so next attempt starts fresh
    agentSessions.delete(agentId);
    handleTaskError(agentId, taskId, agent, task, err, Date.now() - startTime);
  }
}

// ---------------------------------------------------------------------------
// Shared error handler for task execution
// ---------------------------------------------------------------------------

function handleTaskError(
  agentId: string,
  taskId: string,
  agent: { name: string; totalRuns: number },
  task: { title: string },
  err: unknown,
  durationMs: number,
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);

  updateTask(taskId, {
    status: "failed",
    completedAt: new Date().toISOString(),
    result: {
      exitCode: null,
      summary: null,
      costUsd: null,
      model: null,
      errorMessage,
      durationMs,
      usage: null,
    },
  });

  appendTaskActivity(taskId, agent.name, "Failed", `Error: ${errorMessage}`);

  updateAgent(agentId, {
    status: "idle",
    currentTaskId: null,
    totalRuns: agent.totalRuns + 1,
    lastActiveAt: new Date().toISOString(),
  });

  addNotification({ type: "task_failed", agentId, taskId, message: `${agent.name} failed: "${task.title}" - ${errorMessage}` });
  addActivity({ type: "task_failed", agentId, taskId, message: `${agent.name} failed "${task.title}": ${errorMessage}` });

  broadcast({ type: "agent_status", agentId, status: "idle", taskId: null });
}

// ---------------------------------------------------------------------------
// Send message to agent (resume session or new)
// ---------------------------------------------------------------------------

export async function sendMessage(agentId: string, message: string): Promise<void> {
  const state = readState();
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;

  // If working, queue the message
  if (agent.status === "working") {
    updateAgent(agentId, { pendingMessage: message });
    return;
  }

  const useSession = state.settings.executionMode === "session";

  // Set working (no task)
  updateAgent(agentId, { status: "working", lastActiveAt: new Date().toISOString() });
  broadcast({ type: "agent_status", agentId, status: "working", taskId: null });

  console.log(`[message] agent=${agentId} mode=${useSession ? "session" : "one-shot"}`);

  if (useSession) {
    await sendMessageSession(agentId, message, agent);
  } else {
    await sendMessageOneShot(agentId, message, agent);
  }
}

// ---------------------------------------------------------------------------
// Send message — one-shot (execute mode)
// ---------------------------------------------------------------------------

async function sendMessageOneShot(
  agentId: string,
  message: string,
  agent: { sessionParams: Record<string, unknown> | null; totalCostUsd: number },
): Promise<void> {
  const state = readState();
  const provider = getProvider("claude");
  const sessionCwd = (agent.sessionParams as Record<string, unknown> | null)?.cwd as string | undefined;

  try {
    console.log(`[one-shot] sendMessage via provider.execute() agent=${agentId} resumeSession=${!!agent.sessionParams}`);
    const result: ExecutionResult = await provider.execute({
      prompt: message,
      cwd: sessionCwd,
      sessionParams: agent.sessionParams ?? undefined,
      config: {
        skipPermissions: true,
        maxTurns: state.settings.maxTurns,
        timeoutSec: state.settings.timeoutSec,
        model: state.settings.model,
        skillDirs: DEMO_SKILL_DIRS,
      },
      onStart: (pid) => setAgentPid(agentId, pid),
      onEvent: (event: StreamEvent) => {
        pushBuffer(agentId, event);
        broadcast({ type: "agent_output", agentId, event });
      },
    });

    clearAgentPid(agentId);
    const updatedSessionParams = result.sessionParams ?? agent.sessionParams;
    updateAgent(agentId, {
      status: "idle",
      sessionParams: updatedSessionParams,
      totalCostUsd: agent.totalCostUsd + (result.costUsd ?? 0),
      lastActiveAt: new Date().toISOString(),
    });

    broadcast({ type: "agent_status", agentId, status: "idle", taskId: null, sessionParams: updatedSessionParams });
  } catch (err: unknown) {
    clearAgentPid(agentId);
    finishMessageError(agentId, err);
  }
}

// ---------------------------------------------------------------------------
// Send message — session mode (persistent process)
// ---------------------------------------------------------------------------

async function sendMessageSession(
  agentId: string,
  message: string,
  agent: { sessionParams: Record<string, unknown> | null; totalCostUsd: number },
): Promise<void> {
  const sessionCwd = (agent.sessionParams as Record<string, unknown> | null)?.cwd as string | undefined;

  try {
    console.log(`[session] sendMessage via session.send() agent=${agentId}`);
    const session = await getOrCreateSession(agentId, sessionCwd ?? process.cwd());
    if (!session) {
      console.log(`[session] createSession not available, falling back to one-shot`);
      await sendMessageOneShot(agentId, message, agent);
      return;
    }
    console.log(`[session] sending message via session.send() sessionId=${session.sessionId}`);

    const result = await session.send(message);
    const costUsd = result.costUsd ?? 0;
    console.log(`[session] message complete agent=${agentId} cost=$${costUsd.toFixed(4)} stopReason=${result.stopReason}`);

    updateAgent(agentId, {
      status: "idle",
      sessionParams: session.sessionId ? { sessionId: session.sessionId, cwd: sessionCwd ?? process.cwd() } : agent.sessionParams,
      totalCostUsd: agent.totalCostUsd + costUsd,
      lastActiveAt: new Date().toISOString(),
    });

    broadcast({ type: "agent_status", agentId, status: "idle", taskId: null });
  } catch (err: unknown) {
    // If session died, remove it so next attempt starts fresh
    agentSessions.delete(agentId);
    finishMessageError(agentId, err);
  }
}

// ---------------------------------------------------------------------------
// Shared error handler for messages
// ---------------------------------------------------------------------------

function finishMessageError(agentId: string, err: unknown): void {
  updateAgent(agentId, { status: "idle", lastActiveAt: new Date().toISOString() });
  broadcast({ type: "agent_status", agentId, status: "idle", taskId: null });

  const errorEvent: StreamEvent = {
    type: "result",
    text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    cost: null,
    isError: true,
    timestamp: new Date().toISOString(),
  };
  pushBuffer(agentId, errorEvent);
  broadcast({ type: "agent_output", agentId, event: errorEvent });
}
