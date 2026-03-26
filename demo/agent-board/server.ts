// ---------------------------------------------------------------------------
// Agent Board – Express server
// ---------------------------------------------------------------------------

import express from "express";
import { createServer } from "node:http";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { setupTerminalWs } from "./terminal.js";
import {
  getProvider,
  listProviders,
  installSkills,
  removeSkills,
  listInstalledSkills,
} from "../../packages/agent/src/index.js";
import type { SkillLocation } from "../../packages/agent/src/index.js";
import {
  readState,
  writeState,
  addTask,
  updateTask,
  deleteTask,
  updateAgent,
  updateSettings,
  addNotification,
  markAllNotificationsRead,
  addDecision,
  answerDecision,
  addNote,
  updateNote,
  deleteNote,
  readNoteContent,
  writeNoteContent,
  WORKSPACE_DIR,
} from "./store.js";
import { seedData } from "./seed.js";
import { executeTask, sendMessage, consoleBuffers, setBroadcast, getAgentPids, isProcessAlive, clearAgentPid } from "./execution.js";
import { heartbeatTick, setHeartbeatBroadcast } from "./heartbeat.js";
import type { SSEEvent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3457;

app.use(express.json());

// Serve Vite build output (production)
const distDir = join(__dirname, "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listFiles(dir: string, root: string): { path: string; size: number }[] {
  const results: { path: string; size: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      results.push(...listFiles(full, root));
    } else {
      const rel = full.slice(root.length + 1);
      results.push({ path: rel, size: statSync(full).size });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// SSE – Global event stream
// ---------------------------------------------------------------------------

const sseClients = new Set<express.Response>();

function broadcast(event: SSEEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// Wire broadcast into execution + heartbeat modules
setBroadcast(broadcast);
setHeartbeatBroadcast(broadcast);

// ---------------------------------------------------------------------------
// Heartbeat interval
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function restartHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const { heartbeatIntervalSec } = readState().settings;
  heartbeatTimer = setInterval(() => heartbeatTick(), heartbeatIntervalSec * 1000);
}

restartHeartbeat();

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// Full state
app.get("/api/state", (_req, res) => {
  res.json(readState());
});

// SSE stream
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Send current state
  const state = readState();
  res.write(`data: ${JSON.stringify({ type: "state_sync", data: state })}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Console buffer for an agent
app.get("/api/agents/:id/console", (req, res) => {
  const buf = consoleBuffers.get(req.params.id) ?? [];
  res.json(buf);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

app.post("/api/tasks", (req, res) => {
  const { title, description, priority, areaId, goalId } = req.body;
  if (!title || !description) {
    res.status(400).json({ error: "title and description required" });
    return;
  }
  const task = addTask({
    title: title.trim(),
    description: (description || "").trim(),
    status: "todo",
    priority: priority || "medium",
    areaId: areaId || "",
    goalId: goalId || null,
  });
  broadcast({ type: "task_update", task });
  res.status(201).json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = updateTask(req.params.id, req.body);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  broadcast({ type: "task_update", task });
  res.json(task);
});

app.delete("/api/tasks/:id", (req, res) => {
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  if (task?.status === "in_progress") {
    res.status(409).json({ error: "Cannot delete a running task" });
    return;
  }
  if (!deleteTask(req.params.id)) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ ok: true });
});

// Approve proposed task (manual mode)
app.post("/api/tasks/:id/approve", (req, res) => {
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  if (!task || !task.proposedByAgentId) {
    res.status(400).json({ error: "No proposal to approve" });
    return;
  }
  const agentId = task.proposedByAgentId;
  const updated = updateTask(task.id, {
    status: "in_progress",
    assignedAgentId: agentId,
    proposedByAgentId: null,
  });
  if (updated) broadcast({ type: "task_update", task: updated });

  // Start execution
  executeTask(agentId, task.id);
  res.json({ ok: true });
});

// Assign task to a specific agent and start execution
app.post("/api/tasks/:id/assign", (req, res) => {
  const { agentId } = req.body;
  if (!agentId || typeof agentId !== "string") {
    res.status(400).json({ error: "agentId required" });
    return;
  }
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.status === "in_progress") {
    res.status(409).json({ error: "Task is already in progress" });
    return;
  }
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (agent.status === "working") {
    res.status(409).json({ error: `${agent.name} is already working on a task` });
    return;
  }

  const updated = updateTask(task.id, {
    status: "in_progress",
    assignedAgentId: agentId,
    proposedByAgentId: null,
  });
  if (updated) broadcast({ type: "task_update", task: updated });

  executeTask(agentId, task.id);
  res.json({ ok: true });
});

// Seed
app.post("/api/tasks/seed", (_req, res) => {
  const result = seedData();
  broadcast({ type: "state_sync", data: readState() });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

app.post("/api/agents/:id/new-session", (req, res) => {
  const state = readState();
  const agent = state.agents.find((a) => a.id === req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (agent.status === "working") {
    res.status(409).json({ error: "Agent is currently working" });
    return;
  }
  updateAgent(req.params.id, { sessionParams: null, pendingMessage: null });
  consoleBuffers.delete(req.params.id);
  broadcast({ type: "agent_status", agentId: req.params.id, status: agent.status, taskId: agent.currentTaskId });
  res.json({ ok: true });
});

app.post("/api/agents/:id/message", (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message required" });
    return;
  }
  sendMessage(req.params.id, message.trim());
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.patch("/api/settings", (req, res) => {
  const settings = updateSettings(req.body);
  restartHeartbeat();
  broadcast({ type: "state_sync", data: readState() });
  res.json(settings);
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

app.patch("/api/notifications/read", (_req, res) => {
  markAllNotificationsRead();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

app.post("/api/decisions", (req, res) => {
  const { question, context, options, taskId, agentId } = req.body;
  if (!question || !agentId) {
    res.status(400).json({ error: "question and agentId required" });
    return;
  }
  const decision = addDecision({
    question,
    context: context || "",
    options: options || [],
    taskId: taskId || null,
    agentId,
  });
  const notif = addNotification({
    type: "decision_requested",
    agentId,
    taskId: taskId || "",
    message: `Decision needed: "${question}"`,
  });
  broadcast({ type: "notification", data: notif });
  broadcast({ type: "state_sync", data: readState() });
  res.status(201).json(decision);
});

app.patch("/api/decisions/:id", (req, res) => {
  const { answer } = req.body;
  if (!answer) {
    res.status(400).json({ error: "answer required" });
    return;
  }
  const decision = answerDecision(req.params.id, answer);
  if (!decision) {
    res.status(404).json({ error: "Decision not found" });
    return;
  }
  broadcast({ type: "state_sync", data: readState() });
  res.json(decision);
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

app.post("/api/notes", (req, res) => {
  const { title, areaId } = req.body;
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const note = addNote(title.trim(), areaId || null);
  broadcast({ type: "state_sync", data: readState() });
  res.status(201).json(note);
});

app.patch("/api/notes/:id", (req, res) => {
  const note = updateNote(req.params.id, req.body);
  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json(note);
});

app.put("/api/notes/:id/content", (req, res) => {
  const { content } = req.body;
  if (content === undefined) {
    res.status(400).json({ error: "content required" });
    return;
  }
  if (!writeNoteContent(req.params.id, content)) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/notes/:id/content", (req, res) => {
  const content = readNoteContent(req.params.id);
  if (content === null) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json({ content });
});

app.delete("/api/notes/:id", (req, res) => {
  if (!deleteNote(req.params.id)) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  broadcast({ type: "state_sync", data: readState() });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

/** Resolve the effective workspace root for a task. Checks the task's own workspace first,
 *  then falls back to the common root of tracked modifiedFiles. */
function resolveWorkspaceRoot(taskId: string): string | null {
  const taskDir = join(WORKSPACE_DIR, taskId);
  if (existsSync(taskDir) && listFiles(taskDir, taskDir).length > 0) return taskDir;

  const state = readState();
  const task = state.tasks.find((t) => t.id === taskId);
  const mf = task?.modifiedFiles ?? [];
  if (mf.length === 0) return existsSync(taskDir) ? taskDir : null;

  const dirs = mf.map((f) => dirname(f));
  let root = dirs[0]!;
  for (const d of dirs) {
    while (!d.startsWith(root)) root = dirname(root);
  }
  return root;
}

app.get("/api/tasks/:id/files", (req, res) => {
  const taskDir = join(WORKSPACE_DIR, req.params.id);
  const wsExists = existsSync(taskDir);
  const wsFiles = wsExists ? listFiles(taskDir, taskDir) : [];

  if (wsFiles.length > 0) {
    res.json({ root: taskDir, files: wsFiles });
    return;
  }

  // Fall back to tracked modifiedFiles (absolute paths from agent tool calls)
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  const mf = task?.modifiedFiles ?? [];
  if (mf.length === 0) {
    res.json({ root: taskDir, files: [] });
    return;
  }

  // Compute common root directory for display
  const dirs = mf.map((f) => dirname(f));
  let root = dirs[0]!;
  for (const d of dirs) {
    while (!d.startsWith(root)) {
      root = dirname(root);
    }
  }

  const files = mf
    .filter((f) => existsSync(f))
    .map((f) => ({
      path: f.slice(root.length + 1),
      size: statSync(f).size,
    }));
  res.json({ root, files });
});

app.get("/api/tasks/:id/diff", (req, res) => {
  const taskDir = join(WORKSPACE_DIR, req.params.id);

  // Try the task's own workspace first
  if (existsSync(join(taskDir, ".git"))) {
    try {
      execSync("git add -A", { cwd: taskDir, stdio: "ignore" });
      const diff = execSync("git diff --cached HEAD", { cwd: taskDir, encoding: "utf-8", maxBuffer: 1024 * 1024 });
      res.json({ diff });
      return;
    } catch {
      // fall through
    }
  }

  // If modifiedFiles exist in another workspace that has git, try diffing there
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  const mf = task?.modifiedFiles ?? [];
  if (mf.length > 0) {
    // Find a parent dir with .git
    let gitDir = dirname(mf[0]!);
    while (gitDir !== "/" && !existsSync(join(gitDir, ".git"))) {
      gitDir = dirname(gitDir);
    }
    if (existsSync(join(gitDir, ".git"))) {
      try {
        // Diff only the specific modified files
        const relPaths = mf.map((f) => f.slice(gitDir.length + 1)).join(" ");
        execSync("git add -A", { cwd: gitDir, stdio: "ignore" });
        const diff = execSync(`git diff --cached HEAD -- ${relPaths}`, { cwd: gitDir, encoding: "utf-8", maxBuffer: 1024 * 1024 });
        res.json({ diff });
        return;
      } catch {
        // fall through
      }
    }
  }

  res.json({ diff: "" });
});

app.get("/api/tasks/:id/files/*filePath", (req, res) => {
  const raw = (req.params as Record<string, unknown>).filePath;
  const filePath = Array.isArray(raw) ? raw.join("/") : String(raw || "");
  if (!filePath) {
    res.status(400).json({ error: "file path required" });
    return;
  }

  // Try workspace directory first
  const fullPath = join(WORKSPACE_DIR, req.params.id, filePath);
  if (fullPath.startsWith(join(WORKSPACE_DIR, req.params.id)) && existsSync(fullPath)) {
    try {
      const content = readFileSync(fullPath, "utf-8");
      res.json({ content });
      return;
    } catch {
      // fall through
    }
  }

  // Fall back to modifiedFiles — resolve relative path against tracked root
  const state = readState();
  const task = state.tasks.find((t) => t.id === req.params.id);
  const mf = task?.modifiedFiles ?? [];
  if (mf.length > 0) {
    // Recompute the same root as the files list endpoint
    const dirs = mf.map((f) => dirname(f));
    let root = dirs[0]!;
    for (const d of dirs) {
      while (!d.startsWith(root)) root = dirname(root);
    }
    const resolved = join(root, filePath);
    // Verify the file is in the tracked set
    if (mf.includes(resolved) && existsSync(resolved)) {
      try {
        const content = readFileSync(resolved, "utf-8");
        res.json({ content });
        return;
      } catch {
        // fall through
      }
    }
  }

  res.status(404).json({ error: "file not found" });
});

// Open workspace in editor
app.post("/api/tasks/:id/open-editor", (req, res) => {
  const dir = resolveWorkspaceRoot(req.params.id);
  if (!dir) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  const editorCommand = readState().settings.editorCommand || "code";
  const child = spawn(editorCommand, [dir], { detached: true, stdio: "ignore" });
  child.unref();
  res.json({ ok: true, command: `${editorCommand} ${dir}` });
});

// Open workspace in system file manager
app.post("/api/tasks/:id/open-finder", (req, res) => {
  const dir = resolveWorkspaceRoot(req.params.id);
  if (!dir) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "linux" ? "xdg-open" : "open";
  const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
  child.unref();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

app.get("/api/providers", async (_req, res) => {
  const available: Record<string, boolean> = {};
  for (const name of listProviders()) {
    try {
      const provider = getProvider(name);
      const result = await provider.testEnvironment({ providerType: name });
      available[name] = result.status !== "fail";
    } catch {
      available[name] = false;
    }
  }
  res.json(available);
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const DEMO_SKILL_DIRS = [
  join(__dirname, "skills", "code-review"),
  join(__dirname, "skills", "testing"),
  join(__dirname, "skills", "security"),
];

const SKILLS_CWD = __dirname;

// List available demo skills (source dirs on disk)
app.get("/api/skills/available", (_req, res) => {
  const skills = DEMO_SKILL_DIRS.map((dir) => ({
    name: basename(dir),
    sourcePath: dir,
  }));
  res.json({ skills, cwd: SKILLS_CWD });
});

// List installed skills for all channels at a given location
app.get("/api/skills", async (req, res) => {
  const location = (req.query.location as SkillLocation) || "workspace";
  try {
    const result = await listInstalledSkills({
      location,
      cwd: location === "workspace" ? SKILLS_CWD : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Install demo skills
app.post("/api/skills/install", async (req, res) => {
  const { location } = req.body as { location?: SkillLocation };
  const loc = location ?? "workspace";
  try {
    const result = await installSkills(DEMO_SKILL_DIRS, {
      location: loc,
      cwd: loc === "workspace" ? SKILLS_CWD : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Remove demo skills
app.post("/api/skills/remove", async (req, res) => {
  const { location } = req.body as { location?: SkillLocation };
  const loc = location ?? "workspace";
  try {
    const result = await removeSkills(DEMO_SKILL_DIRS, {
      location: loc,
      cwd: loc === "workspace" ? SKILLS_CWD : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Startup reconciliation – no agent process can survive a server restart,
// so reset any "working" agents and their in_progress tasks.
// ---------------------------------------------------------------------------

function reconcileOnStartup(): void {
  const state = readState();
  const pids = getAgentPids();
  let dirty = false;

  for (const agent of state.agents) {
    if (agent.status === "working") {
      const pid = pids[agent.id];
      const alive = pid != null && isProcessAlive(pid);

      if (alive) {
        console.log(`Reconcile: agent "${agent.name}" (PID ${pid}) is still alive — leaving as working`);
        continue;
      }

      console.log(`Reconcile: agent "${agent.name}" process is dead (PID ${pid ?? "unknown"}) — resetting to idle`);

      // Reset the task that was in progress
      if (agent.currentTaskId) {
        const task = state.tasks.find((t) => t.id === agent.currentTaskId);
        if (task && task.status === "in_progress") {
          task.status = "todo";
          task.assignedAgentId = null;
          task.updatedAt = new Date().toISOString();
          console.log(`Reconcile: resetting task "${task.title}" from in_progress → todo`);
        }
      }
      agent.status = "idle";
      agent.currentTaskId = null;
      clearAgentPid(agent.id);
      dirty = true;
    }
  }
  if (dirty) {
    writeState(state);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

reconcileOnStartup();

const httpServer = createServer(app);
setupTerminalWs(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Agent Board demo running at http://localhost:${PORT}`);
});
