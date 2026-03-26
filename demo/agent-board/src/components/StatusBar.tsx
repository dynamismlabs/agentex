import { useState, useEffect } from "react";
import { useApp } from "../AppContext";
import { Activity, Bot, Clock } from "lucide-react";

export default function StatusBar() {
  const { state } = useApp();
  const [, setTick] = useState(0);

  // Update elapsed timers every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-6 px-6 py-2 border-t border-border bg-surface text-xs text-text-tertiary shrink-0 z-10 overflow-x-auto hide-scrollbar">
      <div className="flex items-center gap-1.5 shrink-0 text-text-secondary font-medium">
        <Activity size={14} className="text-primary" />
        <span>System Status</span>
      </div>

      <div className="w-px h-3 bg-border shrink-0"></div>

      {state.agents.map((a) => {
        const reviewTasks = state.tasks.filter((t) => t.assignedAgentId === a.id && t.status === "review");
        const proposals = state.tasks.filter((t) => t.proposedByAgentId === a.id);
        const pendingDecisions = state.decisions.filter((d) => d.agentId === a.id && d.status === "pending");
        const attentionCount = reviewTasks.length + proposals.length + pendingDecisions.length;

        const dotClass =
          a.status === "working"
            ? "bg-emerald-500 animate-pulse-dot shadow-[0_0_8px_rgba(16,185,129,0.6)]"
            : attentionCount > 0
              ? "bg-amber-400 animate-pulse-dot shadow-[0_0_8px_rgba(251,191,36,0.6)]"
              : "bg-zinc-600";

        const task = a.currentTaskId
          ? state.tasks.find((t) => t.id === a.currentTaskId)
          : null;

        let info = a.status as string;
        if (a.status === "working" && task && a.lastActiveAt) {
          const elapsed = Math.round(
            (Date.now() - new Date(a.lastActiveAt).getTime()) / 1000,
          );
          info = `working on "${task.title.slice(0, 30)}" (${elapsed}s)`;
        } else if (attentionCount > 0) {
          const parts: string[] = [];
          if (reviewTasks.length) parts.push(`${reviewTasks.length} to review`);
          if (proposals.length) parts.push(`${proposals.length} proposed`);
          if (pendingDecisions.length) parts.push(`${pendingDecisions.length} decision${pendingDecisions.length > 1 ? "s" : ""}`);
          info = `idle — ${parts.join(", ")}`;
        }

        return (
          <div key={a.id} className="flex items-center gap-2 shrink-0 bg-background px-2.5 py-1 rounded-md border border-border">
            <span className={`w-2 h-2 rounded-full ${dotClass}`} />
            <strong className="text-text-secondary font-medium flex items-center gap-1">
              <Bot size={12} />
              {a.name}
            </strong>
            <span className="text-text-tertiary flex items-center gap-1">
              {task && <Clock size={12} className="opacity-70" />}
              {info}
            </span>
          </div>
        );
      })}
    </div>
  );
}
