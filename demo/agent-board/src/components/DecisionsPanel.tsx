import { useApp } from "../AppContext";
import { api } from "../api";
import { HelpCircle, Bot, Link, CheckCircle2, Send } from "lucide-react";

function timeAgo(iso: string) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

export default function DecisionsPanel() {
  const { state } = useApp();

  if (state.decisions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
        <div className="w-16 h-16 mb-4 rounded-full bg-surface-hover flex items-center justify-center">
          <HelpCircle size={24} className="opacity-50" />
        </div>
        <p className="text-sm font-medium text-text-secondary">No decisions yet</p>
        <p className="text-xs mt-1">Agents will ask for your input here</p>
      </div>
    );
  }

  const sorted = [...state.decisions].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  async function answer(id: string, answer: string) {
    await api("PATCH", `/api/decisions/${id}`, { answer });
  }

  function handleFreeform(id: string) {
    const input = document.getElementById(`dec-${id}`) as HTMLInputElement;
    if (!input?.value.trim()) return;
    answer(id, input.value.trim());
  }

  return (
    <div className="p-6 max-w-3xl mx-auto flex flex-col gap-4">
      {sorted.map((d) => {
        const agent = state.agents.find((a) => a.id === d.agentId);
        const isPending = d.status === "pending";

        return (
          <div
            key={d.id}
            className={`bg-surface border rounded-xl p-5 transition-all duration-200 shadow-sm ${isPending
              ? "border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.05)]"
              : "border-border opacity-70 hover:opacity-100"
              }`}
          >
            <div className="flex items-start gap-3 mb-3">
              <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${isPending ? 'bg-amber-500 animate-pulse-dot' : 'bg-emerald-500'}`} />
              <div className="flex-1">
                <div className="text-base font-medium text-text-primary leading-snug mb-2">{d.question}</div>
                <div className="text-sm text-text-secondary bg-background p-3 rounded-lg border border-border leading-relaxed mb-3">
                  {d.context}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary mb-4">
                  {agent && (
                    <div className="flex items-center gap-1 text-primary bg-primary/5 px-2 py-0.5 rounded-full border border-primary/10">
                      <Bot size={12} />
                      <span className="font-medium">{agent.name}</span>
                    </div>
                  )}
                  <span>{timeAgo(d.createdAt)}</span>
                  {d.taskId && (
                    <div className="flex items-center gap-1 text-text-secondary">
                      <Link size={12} />
                      <span>Linked to task</span>
                    </div>
                  )}
                </div>

                {/* Option buttons */}
                {isPending && d.options.length > 0 && (
                  <div className="flex gap-2 flex-wrap mb-3">
                    {d.options.map((o) => (
                      <button
                        key={o}
                        className="px-4 py-2 bg-background border border-border rounded-lg text-sm text-text-primary hover:bg-primary hover:text-black hover:border-primary transition-colors shadow-sm"
                        onClick={() => answer(d.id, o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}

                {/* Free-form input */}
                {isPending && (
                  <div className="flex gap-2 mt-2">
                    <input
                      id={`dec-${d.id}`}
                      className="flex-1 px-4 py-2 bg-background border border-border rounded-lg text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-text-tertiary"
                      placeholder="Type your answer..."
                      onKeyDown={(e) =>
                        e.key === "Enter" && handleFreeform(d.id)
                      }
                    />
                    <button
                      className="flex items-center justify-center gap-1.5 px-4 py-2 bg-surface-hover border border-border hover:bg-primary hover:text-black hover:border-primary rounded-lg text-sm font-medium transition-colors"
                      onClick={() => handleFreeform(d.id)}
                    >
                      <Send size={14} />
                      Send
                    </button>
                  </div>
                )}

                {/* Answered */}
                {d.answer && (
                  <div className="flex items-center gap-2 mt-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg text-sm text-emerald-400">
                    <CheckCircle2 size={16} />
                    <span><span className="font-medium">Answered:</span> {d.answer}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
