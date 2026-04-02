// ---------------------------------------------------------------------------
// Agent Board – File-based store (index.json + markdown files)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppState, Agent, Task, Goal, Area, Decision, Note, Notification, ActivityEvent, Settings } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "data");
const INDEX_FILE = join(DATA_DIR, "index.json");

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS: Agent[] = [
  { id: "agent-1", name: "Atlas", status: "idle", currentTaskId: null, sessionParams: null, pendingMessage: null, totalRuns: 0, totalCostUsd: 0, lastActiveAt: null },
  { id: "agent-2", name: "Nova", status: "idle", currentTaskId: null, sessionParams: null, pendingMessage: null, totalRuns: 0, totalCostUsd: 0, lastActiveAt: null },
  { id: "agent-3", name: "Orion", status: "idle", currentTaskId: null, sessionParams: null, pendingMessage: null, totalRuns: 0, totalCostUsd: 0, lastActiveAt: null },
];

const DEFAULT_SETTINGS: Settings = {
  heartbeatEnabled: false,
  heartbeatMode: "auto",
  heartbeatIntervalSec: 30,
  model: "claude-sonnet-4-6",
  maxTurns: 10,
  timeoutSec: 300,
  editorCommand: "code",
  executionMode: "execute",
};

function defaultState(): AppState {
  return {
    agents: structuredClone(DEFAULT_AGENTS),
    tasks: [],
    goals: [],
    areas: [],
    decisions: [],
    notes: [],
    notifications: [],
    activity: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readState(): AppState {
  try {
    const raw = readFileSync(INDEX_FILE, "utf-8");
    const state = JSON.parse(raw) as AppState;
    // Ensure agents always exist
    if (!state.agents || state.agents.length === 0) {
      state.agents = structuredClone(DEFAULT_AGENTS);
    }
    if (!state.settings) {
      state.settings = { ...DEFAULT_SETTINGS };
    }
    if (!state.settings.editorCommand) {
      state.settings.editorCommand = DEFAULT_SETTINGS.editorCommand;
    }
    if (!state.settings.executionMode) {
      state.settings.executionMode = DEFAULT_SETTINGS.executionMode;
    }
    if (!state.activity) state.activity = [];
    if (!state.notifications) state.notifications = [];
    if (!state.decisions) state.decisions = [];
    if (!state.notes) state.notes = [];
    // Migrate tasks missing modifiedFiles
    for (const t of state.tasks) {
      if (!t.modifiedFiles) t.modifiedFiles = [];
    }
    // Migrate agents with removed statuses back to idle
    for (const a of state.agents) {
      if (a.status !== "idle" && a.status !== "working") {
        a.status = "idle";
        a.currentTaskId = null;
      }
    }
    return state;
  } catch {
    return defaultState();
  }
}

export function writeState(state: AppState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export function addTask(t: Omit<Task, "id" | "createdAt" | "updatedAt" | "completedAt" | "result" | "assignedAgentId" | "proposedByAgentId" | "modifiedFiles">): Task {
  const state = readState();
  const now = new Date().toISOString();
  const task: Task = {
    id: `task_${Date.now()}`,
    ...t,
    assignedAgentId: null,
    proposedByAgentId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    result: null,
    modifiedFiles: [],
  };
  state.tasks.push(task);
  writeState(state);
  ensureTaskMarkdown(task);
  return task;
}

export function updateTask(id: string, patch: Partial<Task>): Task | null {
  const state = readState();
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  state.tasks[idx] = { ...state.tasks[idx]!, ...patch, updatedAt: new Date().toISOString() };
  writeState(state);
  return state.tasks[idx]!;
}

export function deleteTask(id: string): boolean {
  const state = readState();
  const before = state.tasks.length;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (state.tasks.length === before) return false;
  writeState(state);
  return true;
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

export function updateAgent(id: string, patch: Partial<Agent>): Agent | null {
  const state = readState();
  const idx = state.agents.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  state.agents[idx] = { ...state.agents[idx]!, ...patch };
  writeState(state);
  return state.agents[idx]!;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function updateSettings(patch: Partial<Settings>): Settings {
  const state = readState();
  state.settings = { ...state.settings, ...patch };
  writeState(state);
  return state.settings;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function addNotification(n: Omit<Notification, "id" | "createdAt" | "read">): Notification {
  const state = readState();
  const notif: Notification = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...n,
    read: false,
    createdAt: new Date().toISOString(),
  };
  state.notifications.unshift(notif);
  // Keep last 100
  if (state.notifications.length > 100) state.notifications = state.notifications.slice(0, 100);
  writeState(state);
  return notif;
}

export function markAllNotificationsRead(): void {
  const state = readState();
  for (const n of state.notifications) n.read = true;
  writeState(state);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function addActivity(a: Omit<ActivityEvent, "id" | "timestamp">): ActivityEvent {
  const state = readState();
  const event: ActivityEvent = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...a,
    timestamp: new Date().toISOString(),
  };
  state.activity.unshift(event);
  if (state.activity.length > 200) state.activity = state.activity.slice(0, 200);
  writeState(state);
  return event;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function addDecision(d: Omit<Decision, "id" | "createdAt" | "answeredAt" | "status" | "answer">): Decision {
  const state = readState();
  const decision: Decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...d,
    status: "pending",
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  state.decisions.push(decision);
  writeState(state);
  return decision;
}

export function answerDecision(id: string, answer: string): Decision | null {
  const state = readState();
  const idx = state.decisions.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  state.decisions[idx] = {
    ...state.decisions[idx]!,
    status: "answered",
    answer,
    answeredAt: new Date().toISOString(),
  };
  writeState(state);
  return state.decisions[idx]!;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const NOTES_DIR = join(DATA_DIR, "notes");

export function addNote(title: string, areaId: string | null): Note {
  const state = readState();
  const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const file = `notes/${id}.md`;
  const now = new Date().toISOString();
  const note: Note = { id, title, areaId, file, createdAt: now, updatedAt: now };
  state.notes.push(note);
  writeState(state);
  // Create file
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, file), `# ${title}\n\n`);
  return note;
}

export function updateNote(id: string, patch: Partial<Pick<Note, "title" | "areaId">>): Note | null {
  const state = readState();
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  state.notes[idx] = { ...state.notes[idx]!, ...patch, updatedAt: new Date().toISOString() };
  writeState(state);
  return state.notes[idx]!;
}

export function deleteNote(id: string): boolean {
  const state = readState();
  const note = state.notes.find((n) => n.id === id);
  if (!note) return false;
  state.notes = state.notes.filter((n) => n.id !== id);
  writeState(state);
  // Delete file
  const filePath = join(DATA_DIR, note.file);
  if (existsSync(filePath)) unlinkSync(filePath);
  return true;
}

export function readNoteContent(id: string): string | null {
  const state = readState();
  const note = state.notes.find((n) => n.id === id);
  if (!note) return null;
  const filePath = join(DATA_DIR, note.file);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function writeNoteContent(id: string, content: string): boolean {
  const state = readState();
  const note = state.notes.find((n) => n.id === id);
  if (!note) return false;
  const filePath = join(DATA_DIR, note.file);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  // Update timestamp
  updateNote(id, {});
  return true;
}

// ---------------------------------------------------------------------------
// Task markdown
// ---------------------------------------------------------------------------

const TASKS_DIR = join(DATA_DIR, "tasks");

export function ensureTaskMarkdown(task: Task): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  const filePath = join(TASKS_DIR, `${task.id}.md`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# ${task.title}\n\n${task.description}\n\n## Agent Activity\n\n`);
  }
}

export function appendTaskActivity(taskId: string, agentName: string, action: string, detail: string): void {
  const filePath = join(TASKS_DIR, `${taskId}.md`);
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const entry = `### [${ts}] ${agentName} - ${action}\n${detail}\n\n`;
  try {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + entry);
  } catch {
    // File doesn't exist, skip
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const WORKSPACE_DIR = join(DATA_DIR, "workspaces");

export function ensureWorkspace(taskId: string): string {
  const dir = join(WORKSPACE_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
