import { useApp } from "../AppContext";
import { api } from "../api";
import WorkspaceFiles from "./WorkspaceFiles";
import {
  X,
  Bot,
  Target,
  Clock,
  DollarSign,
  CheckCircle2,
  Trash2,
} from "lucide-react";

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

export default function TaskDetailModal() {
  const { state, setState, selectedTaskId, setSelectedTaskId } = useApp();
  const task = selectedTaskId
    ? state.tasks.find((t) => t.id === selectedTaskId)
    : null;

  if (!task) return null;

  const area = state.areas.find((a) => a.id === task.areaId);
  const agent = task.assignedAgentId
    ? state.agents.find((a) => a.id === task.assignedAgentId)
    : null;
  const proposed = task.proposedByAgentId
    ? state.agents.find((a) => a.id === task.proposedByAgentId)
    : null;
  const goal = task.goalId
    ? state.goals.find((g) => g.id === task.goalId)
    : null;
  const r = task.result;

  async function handleApprove() {
    await api("POST", `/api/tasks/${task!.id}/approve`);
  }

  async function handleMarkDone() {
    await api("PATCH", `/api/tasks/${task!.id}`, { status: "done" });
  }

  async function handleDelete() {
    await api("DELETE", `/api/tasks/${task!.id}`);
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== task!.id),
    }));
    setSelectedTaskId(null);
  }

  function close() {
    setSelectedTaskId(null);
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="bg-surface border border-border rounded-2xl w-[720px] max-w-[90vw] max-h-[85vh] shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-6 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-3">
              {area && (
                <div
                  className="w-3 h-3 rounded-full shrink-0 shadow-sm"
                  style={{
                    background: area.color,
                    boxShadow: `0 0 8px ${area.color}80`,
                  }}
                />
              )}
              <h2 className="text-lg font-semibold text-text-primary leading-tight truncate">
                {task.title}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${priorityClass[task.priority] ?? ""}`}
              >
                {task.priority}
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${statusClass[task.status] ?? ""}`}
              >
                {task.status.replace("_", " ")}
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
                  <span className="truncate max-w-[200px]">{goal.title}</span>
                </div>
              )}
              {area && (
                <div className="flex items-center gap-1 text-xs text-text-secondary bg-surface-hover px-2 py-0.5 rounded-full border border-border">
                  <span>{area.name}</span>
                </div>
              )}
            </div>
          </div>
          <button
            className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors shrink-0"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
                Description
              </h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                {task.description}
              </p>
            </div>
          )}

          {/* Result */}
          {r && (
            <div>
              <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
                Result
              </h3>
              <div className="p-3 bg-background rounded-lg border border-border">
                {r.summary && (
                  <p className="text-sm text-text-secondary mb-3 leading-relaxed">
                    {r.summary}
                  </p>
                )}
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
                  {r.usage && (
                    <div className="flex items-center gap-1">
                      <span>
                        {r.usage.inputTokens.toLocaleString()} in /{" "}
                        {r.usage.outputTokens.toLocaleString()} out
                      </span>
                    </div>
                  )}
                </div>
                {r.errorMessage && (
                  <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded text-xs">
                    {r.errorMessage}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Workspace files */}
          <div>
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
              Workspace Files
            </h3>
            <WorkspaceFiles taskId={task.id} defaultOpen />
          </div>

          {/* Metadata */}
          <div>
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
              Details
            </h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="text-text-tertiary">Created</div>
              <div className="text-text-secondary">
                {new Date(task.createdAt).toLocaleString()}
              </div>
              {task.completedAt && (
                <>
                  <div className="text-text-tertiary">Completed</div>
                  <div className="text-text-secondary">
                    {new Date(task.completedAt).toLocaleString()}
                  </div>
                </>
              )}
              <div className="text-text-tertiary">Task ID</div>
              <div className="text-text-secondary font-mono">{task.id}</div>
            </div>
          </div>

          {/* Proposed agent */}
          {proposed && (
            <div className="flex items-center justify-between p-2.5 bg-primary/5 border border-primary/20 rounded-lg">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-primary" />
                <span className="text-sm text-text-primary">
                  <span className="font-medium text-primary">
                    {proposed.name}
                  </span>{" "}
                  wants to work on this
                </span>
              </div>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-black rounded-md text-sm font-medium hover:bg-primary-hover transition-colors shadow-sm"
                onClick={handleApprove}
              >
                <CheckCircle2 size={16} />
                Approve
              </button>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between p-4 border-t border-border shrink-0 bg-surface">
          <div>
            {task.status !== "in_progress" && (
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-text-tertiary hover:text-red-400 hover:bg-red-400/10 rounded-md text-sm transition-colors"
                onClick={handleDelete}
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {task.status === "review" && (
              <button
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-500 text-black rounded-lg text-sm font-medium hover:bg-emerald-400 transition-colors shadow-sm"
                onClick={handleMarkDone}
              >
                <CheckCircle2 size={16} />
                Mark Done
              </button>
            )}
            <button
              className="px-4 py-2 bg-surface-hover border border-border rounded-lg text-sm font-medium text-text-primary hover:bg-border transition-colors"
              onClick={close}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
