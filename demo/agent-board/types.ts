// ---------------------------------------------------------------------------
// Agent Board – Data Model
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  status: "idle" | "working";
  currentTaskId: string | null;
  sessionParams: Record<string, unknown> | null;
  pendingMessage: string | null;
  totalRuns: number;
  totalCostUsd: number;
  lastActiveAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "review" | "done" | "failed";
  priority: "critical" | "high" | "medium" | "low";
  areaId: string;
  goalId: string | null;
  assignedAgentId: string | null;
  proposedByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: TaskResult | null;
  modifiedFiles: string[];
}

export interface TaskResult {
  exitCode: number | null;
  summary: string | null;
  costUsd: number | null;
  model: string | null;
  errorMessage: string | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
}

export interface Goal {
  id: string;
  title: string;
  areaId: string;
  status: "active" | "completed";
  createdAt: string;
}

export interface Area {
  id: string;
  name: string;
  color: string;
}

export interface Decision {
  id: string;
  question: string;
  context: string;
  options: string[];
  taskId: string | null;
  agentId: string;
  status: "pending" | "answered";
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface Note {
  id: string;
  title: string;
  areaId: string | null;
  file: string;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  type: "task_completed" | "task_failed" | "task_proposed" | "task_claimed" | "decision_requested";
  agentId: string;
  taskId: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  agentId: string | null;
  taskId: string | null;
  message: string;
  timestamp: string;
}

export interface Settings {
  heartbeatEnabled: boolean;
  heartbeatMode: "auto" | "manual";
  heartbeatIntervalSec: number;
  model: string;
  maxTurns: number;
  timeoutSec: number;
  editorCommand: string;
  /** "execute" = one-shot per turn, "session" = persistent multi-turn process */
  executionMode: "execute" | "session";
}

export interface AppState {
  agents: Agent[];
  tasks: Task[];
  goals: Goal[];
  areas: Area[];
  decisions: Decision[];
  notes: Note[];
  notifications: Notification[];
  activity: ActivityEvent[];
  settings: Settings;
}

export type SSEEvent =
  | { type: "agent_output"; agentId: string; event: unknown }
  | { type: "agent_status"; agentId: string; status: string; taskId: string | null; sessionParams?: unknown }
  | { type: "task_update"; task: Task }
  | { type: "notification"; data: Notification }
  | { type: "heartbeat_tick"; timestamp: string; idleAgents: number; availableTasks: number }
  | { type: "state_sync"; data: AppState };
