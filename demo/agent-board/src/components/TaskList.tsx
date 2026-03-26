import { useState, useRef, useEffect } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import type { Task, Agent } from "../../types";
import { Bot, Target, Clock, DollarSign, Trash2, CheckCircle2, Play } from "lucide-react";

const priorityClass: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border border-red-500/20",
  high: "bg-amber-500/10 text-amber-400 border border-amber-500/20",
  medium: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
  low: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
};

const statusClass: Record<string, string> = {
  backlog: "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20",
  todo: "bg-zinc-500/10 text-zinc-300 border border-zinc-500/20",
  in_progress: "bg-primary/10 text-primary border border-primary/20",
  review: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
  done: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  failed: "bg-red-500/10 text-red-400 border border-red-500/20",
};

function statusOrder(s: string) {
  const o: Record<string, number> = { review: 0, in_progress: 1, todo: 2, backlog: 3, done: 4, failed: 5 };
  return o[s] ?? 9;
}

function priorityOrder(p: string) {
  const o: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return o[p] ?? 9;
}

export default function TaskList() {
  const { state, setState, setSelectedTaskId } = useApp();

  if (state.tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
        <div className="w-16 h-16 mb-4 rounded-full bg-surface-hover flex items-center justify-center">
          <Target size={24} className="opacity-50" />
        </div>
        <p className="text-sm font-medium text-text-secondary">No tasks yet</p>
        <p className="text-xs mt-1">Click Seed or Add Task to get started</p>
      </div>
    );
  }

  const sorted = [...state.tasks].sort((a, b) => {
    const sd = statusOrder(a.status) - statusOrder(b.status);
    if (sd !== 0) return sd;
    return priorityOrder(a.priority) - priorityOrder(b.priority);
  });

  async function handleDelete(id: string) {
    await api("DELETE", `/api/tasks/${id}`);
    setState((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.id !== id) }));
  }

  async function handleApprove(id: string) {
    await api("POST", `/api/tasks/${id}/approve`);
  }

  async function handleAssign(taskId: string, agentId: string) {
    await api("POST", `/api/tasks/${taskId}/assign`, { agentId });
  }

  async function handleMarkDone(id: string) {
    await api("PATCH", `/api/tasks/${id}`, { status: "done" });
  }

  return (
    <div className="p-6 flex flex-col gap-3 max-w-5xl mx-auto">
      {sorted.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          state={state}
          onDelete={handleDelete}
          onApprove={handleApprove}
          onAssign={handleAssign}
          onMarkDone={handleMarkDone}
          onClick={setSelectedTaskId}
        />
      ))}
    </div>
  );
}

function TaskCard({
  task: t,
  state,
  onDelete,
  onApprove,
  onAssign,
  onMarkDone,
  onClick,
}: {
  task: Task;
  state: { areas: { id: string; name: string; color: string }[]; agents: Agent[]; goals: { id: string; title: string }[] };
  onDelete: (id: string) => void;
  onApprove: (id: string) => void;
  onAssign: (taskId: string, agentId: string) => void;
  onMarkDone: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const area = state.areas.find((a) => a.id === t.areaId);
  const agent = t.assignedAgentId ? state.agents.find((a) => a.id === t.assignedAgentId) : null;
  const proposed = t.proposedByAgentId ? state.agents.find((a) => a.id === t.proposedByAgentId) : null;
  const goal = t.goalId ? state.goals.find((g) => g.id === t.goalId) : null;
  const r = t.result;
  const canAssign = !t.assignedAgentId && t.status !== "in_progress" && t.status !== "done";
  const idleAgents = state.agents.filter((a) => a.status === "idle");
  const isReview = t.status === "review";

  return (
    <div
      className={`group bg-surface border rounded-xl p-4 hover:shadow-md transition-all duration-200 cursor-pointer ${isReview ? "border-purple-500/40 bg-purple-500/5" : "border-border hover:border-border-hover"}`}
      onClick={() => onClick(t.id)}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 flex-1">
          {area && (
            <div
              className="mt-1 w-3 h-3 rounded-full shrink-0 shadow-sm"
              style={{ background: area.color, boxShadow: `0 0 8px ${area.color}80` }}
            />
          )}
          <div>
            <h3 className="text-base font-medium text-text-primary leading-tight mb-1.5">{t.title}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${priorityClass[t.priority] ?? ""}`}>
                {t.priority}
              </span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${statusClass[t.status] ?? ""}`}>
                {t.status.replace("_", " ")}
              </span>

              {agent && (
                <div className="flex items-center gap-1 text-xs text-primary bg-primary/5 px-2 py-0.5 rounded-full border border-primary/10">
                  <Bot size={12} />
                  <span>{agent.name}</span>
                </div>
              )}

              {goal && (
                <div className="flex items-center gap-1 text-xs text-text-secondary bg-surface-hover px-2 py-0.5 rounded-full border border-border">
                  <Target size={12} />
                  <span className="truncate max-w-[150px]">{goal.title}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {canAssign && <AssignMenu idleAgents={idleAgents} onAssign={(agentId) => onAssign(t.id, agentId)} />}
          {t.status !== "in_progress" && (
            <button
              className="p-1.5 text-text-tertiary hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors"
              onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
              title="Delete Task"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {r && (
        <div className="mt-3 p-3 bg-background rounded-lg border border-border text-sm">
          {r.summary && <p className="text-text-secondary mb-2 leading-relaxed">{r.summary}</p>}

          <div className="flex items-center gap-4 text-xs text-text-tertiary">
            {r.model && (
              <div className="flex items-center gap-1">
                <Bot size={12} />
                <span>{r.model}</span>
              </div>
            )}
            {r.costUsd != null && (
              <div className="flex items-center gap-1">
                <DollarSign size={12} />
                <span>${r.costUsd.toFixed(4)}</span>
              </div>
            )}
            {r.durationMs != null && (
              <div className="flex items-center gap-1">
                <Clock size={12} />
                <span>{(r.durationMs / 1000).toFixed(1)}s</span>
              </div>
            )}
          </div>

          {r.errorMessage && (
            <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded text-xs">
              {r.errorMessage}
            </div>
          )}
        </div>
      )}

      {proposed && (
        <div className="mt-3 flex items-center justify-between p-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-primary" />
            <span className="text-sm text-text-primary">
              <span className="font-medium text-primary">{proposed.name}</span> wants to work on this
            </span>
          </div>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-black rounded-md text-sm font-medium hover:bg-primary-hover transition-colors shadow-sm"
            onClick={(e) => { e.stopPropagation(); onApprove(t.id); }}
          >
            <CheckCircle2 size={16} />
            Approve
          </button>
        </div>
      )}

      {isReview && (
        <div className="mt-3 flex items-center justify-between p-2.5 bg-purple-500/5 border border-purple-500/20 rounded-lg">
          <span className="text-sm text-purple-400 font-medium">Ready for review</span>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-black rounded-md text-sm font-medium hover:bg-emerald-400 transition-colors shadow-sm"
            onClick={(e) => { e.stopPropagation(); onMarkDone(t.id); }}
          >
            <CheckCircle2 size={16} />
            Mark Done
          </button>
        </div>
      )}
    </div>
  );
}

function AssignMenu({
  idleAgents,
  onAssign,
}: {
  idleAgents: Agent[];
  onAssign: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="p-1.5 text-text-tertiary hover:text-emerald-400 hover:bg-emerald-400/10 rounded-md transition-colors"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Assign to agent"
      >
        <Play size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          {idleAgents.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-tertiary">No idle agents</div>
          ) : (
            idleAgents.map((a) => (
              <button
                key={a.id}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onAssign(a.id);
                  setOpen(false);
                }}
              >
                <Bot size={14} className="text-primary" />
                {a.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
