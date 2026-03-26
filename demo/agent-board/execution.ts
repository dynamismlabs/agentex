// ---------------------------------------------------------------------------
// Agent Board – Agent execution, console buffers, session resume
// ---------------------------------------------------------------------------

import { getProvider } from "../../packages/agent/src/index.js";
import type { StreamEvent, ExecutionResult } from "../../packages/agent/src/index.js";
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
import type { SSEEvent } from "./types.js";

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
];

const MAX_BUFFER = 500;

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
// Execute a task
// ---------------------------------------------------------------------------

export async function executeTask(agentId: string, taskId: string): Promise<void> {
  const state = readState();
  const agent = state.agents.find((a) => a.id === agentId);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!agent || !task) return;

  const provider = getProvider("claude");
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

  const startTime = Date.now();
  const modifiedFiles = new Set<string>();

  try {
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
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

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

  const provider = getProvider("claude");
  const sessionCwd = (agent.sessionParams as Record<string, unknown> | null)?.cwd as string | undefined;

  // Set working (no task)
  updateAgent(agentId, { status: "working", lastActiveAt: new Date().toISOString() });
  broadcast({ type: "agent_status", agentId, status: "working", taskId: null });

  try {
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
    updateAgent(agentId, { status: "idle", lastActiveAt: new Date().toISOString() });
    broadcast({ type: "agent_status", agentId, status: "idle", taskId: null });

    // Push error to console buffer
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
}
