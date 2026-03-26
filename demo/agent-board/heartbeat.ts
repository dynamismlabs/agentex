// ---------------------------------------------------------------------------
// Agent Board – Heartbeat system
// ---------------------------------------------------------------------------

import { readState, updateTask, updateAgent, addNotification, addActivity } from "./store.js";
import { executeTask } from "./execution.js";
import type { SSEEvent } from "./types.js";

let broadcastFn: ((event: SSEEvent) => void) | null = null;

export function setHeartbeatBroadcast(fn: (event: SSEEvent) => void): void {
  broadcastFn = fn;
}

function broadcast(event: SSEEvent): void {
  broadcastFn?.(event);
}

// ---------------------------------------------------------------------------
// Single heartbeat tick
// ---------------------------------------------------------------------------

export function heartbeatTick(): void {
  const state = readState();
  const { settings } = state;

  if (!settings.heartbeatEnabled) return;

  // Find idle agents
  const idleAgents = state.agents.filter((a) => a.status === "idle");

  // Find tasks with pending decisions (these should be skipped)
  const pendingDecisionTaskIds = new Set(
    state.decisions
      .filter((d) => d.status === "pending" && d.taskId)
      .map((d) => d.taskId!)
  );

  // Find available tasks: todo, unassigned, not proposed, no pending decisions
  const availableTasks = state.tasks
    .filter(
      (t) =>
        t.status === "todo" &&
        !t.assignedAgentId &&
        !t.proposedByAgentId &&
        !pendingDecisionTaskIds.has(t.id)
    )
    .sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  // Assign tasks to idle agents
  let taskIdx = 0;
  for (const agent of idleAgents) {
    if (taskIdx >= availableTasks.length) break;
    const task = availableTasks[taskIdx]!;
    taskIdx++;

    if (settings.heartbeatMode === "auto") {
      // Auto mode: assign and start
      updateTask(task.id, { status: "in_progress", assignedAgentId: agent.id });
      addNotification({
        type: "task_claimed",
        agentId: agent.id,
        taskId: task.id,
        message: `${agent.name} started working on "${task.title}"`,
      });
      addActivity({
        type: "task_claimed",
        agentId: agent.id,
        taskId: task.id,
        message: `${agent.name} claimed "${task.title}"`,
      });

      // Execute in background (don't await)
      executeTask(agent.id, task.id);
    } else {
      // Manual mode: propose only
      updateTask(task.id, { proposedByAgentId: agent.id });
      addNotification({
        type: "task_proposed",
        agentId: agent.id,
        taskId: task.id,
        message: `${agent.name} wants to work on "${task.title}"`,
      });
      addActivity({
        type: "task_proposed",
        agentId: agent.id,
        taskId: task.id,
        message: `${agent.name} proposed "${task.title}"`,
      });
    }
  }

  // Broadcast heartbeat event
  broadcast({
    type: "heartbeat_tick",
    timestamp: new Date().toISOString(),
    idleAgents: idleAgents.length,
    availableTasks: availableTasks.length,
  });

  addActivity({
    type: "heartbeat_tick",
    agentId: null,
    taskId: null,
    message: `Heartbeat: ${idleAgents.length} idle agents, ${availableTasks.length} available tasks`,
  });
}
