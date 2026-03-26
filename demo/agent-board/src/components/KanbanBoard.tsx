import { useState, useRef, useEffect } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import type { Task, Agent } from "../../types";
import { Bot, CheckCircle2, Play } from "lucide-react";

const COLUMNS = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
] as const;

const priorityClass: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border border-red-500/20",
  high: "bg-amber-500/10 text-amber-400 border border-amber-500/20",
  medium: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
  low: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
};

export default function KanbanBoard() {
  const { state, setSelectedTaskId } = useApp();
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  async function handleDrop(e: React.DragEvent, newStatus: string) {
    e.preventDefault();
    setDragOverCol(null);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.status === "in_progress") return;
    await api("PATCH", `/api/tasks/${taskId}`, { status: newStatus });
  }

  async function handleApprove(id: string) {
    await api("POST", `/api/tasks/${id}/approve`);
  }

  async function handleAssign(taskId: string, agentId: string) {
    await api("POST", `/api/tasks/${taskId}/assign`, { agentId });
  }

  return (
    <div className="flex gap-4 p-6 overflow-x-auto h-full hide-scrollbar">
      {COLUMNS.map((col) => {
        const tasks = state.tasks.filter((t) => t.status === col.status);
        return (
          <div
            key={col.status}
            className="flex-1 min-w-[280px] max-w-[320px] bg-surface/50 border border-border rounded-xl flex flex-col max-h-full"
          >
            <div className="px-4 py-3 text-sm font-semibold text-text-primary border-b border-border flex items-center justify-between bg-surface rounded-t-xl">
              <div className="flex items-center gap-2">
                {col.label}
                <span className="bg-background px-2 py-0.5 rounded-full text-xs font-medium text-text-secondary border border-border">
                  {tasks.length}
                </span>
              </div>
            </div>
            <div
              className={`flex-1 overflow-y-auto p-3 flex flex-col gap-3 transition-colors duration-200 ${dragOverCol === col.status ? "bg-primary/5" : ""
                }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverCol(col.status);
              }}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={(e) => handleDrop(e, col.status)}
            >
              {tasks.map((t) => (
                <KanbanCard key={t.id} task={t} onApprove={handleApprove} onAssign={handleAssign} onClick={setSelectedTaskId} />
              ))}
              {tasks.length === 0 && (
                <div className="h-24 border-2 border-dashed border-border rounded-lg flex items-center justify-center text-text-tertiary text-sm">
                  Drop here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  task: t,
  onApprove,
  onAssign,
  onClick,
}: {
  task: Task;
  onApprove: (id: string) => void;
  onAssign: (taskId: string, agentId: string) => void;
  onClick: (id: string) => void;
}) {
  const { state } = useApp();
  const area = state.areas.find((a) => a.id === t.areaId);
  const agent = t.assignedAgentId
    ? state.agents.find((a) => a.id === t.assignedAgentId)
    : null;
  const proposed = t.proposedByAgentId
    ? state.agents.find((a) => a.id === t.proposedByAgentId)
    : null;
  const canAssign = !t.assignedAgentId && t.status !== "in_progress" && t.status !== "done";
  const idleAgents = state.agents.filter((a) => a.status === "idle");

  return (
    <div
      className="bg-surface border border-border rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-border-hover hover:shadow-md transition-all duration-200 group"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
      onClick={() => onClick(t.id)}
    >
      <div className="flex items-start gap-2 mb-2">
        {area && (
          <div
            className="mt-1 w-2.5 h-2.5 rounded-full shrink-0 shadow-sm"
            style={{ background: area.color, boxShadow: `0 0 6px ${area.color}80` }}
          />
        )}
        <span className="font-medium text-sm leading-snug text-text-primary flex-1">{t.title}</span>
        {canAssign && (
          <KanbanAssignMenu idleAgents={idleAgents} onAssign={(agentId) => onAssign(t.id, agentId)} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${priorityClass[t.priority] ?? ""}`}
        >
          {t.priority}
        </span>
        {agent && (
          <div className="flex items-center gap-1 text-xs text-text-secondary bg-background px-2 py-0.5 rounded-full border border-border">
            <Bot size={12} />
            <span>{agent.name}</span>
          </div>
        )}
      </div>

      {proposed && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs text-text-secondary mb-2">
            <span className="font-medium text-primary">{proposed.name}</span> wants to work on this
          </p>
          <button
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary text-black rounded-md text-xs font-medium hover:bg-primary-hover transition-colors shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              onApprove(t.id);
            }}
          >
            <CheckCircle2 size={14} />
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

function KanbanAssignMenu({
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
        className="p-1 text-text-tertiary hover:text-emerald-400 hover:bg-emerald-400/10 rounded transition-colors opacity-0 group-hover:opacity-100"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Assign to agent"
      >
        <Play size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
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
                onMouseDown={(e) => e.stopPropagation()}
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
