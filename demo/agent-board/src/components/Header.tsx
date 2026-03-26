import { useState, useRef, useEffect } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import { Bell, Settings, Activity, CheckCircle2, Eye, MessageSquare, HelpCircle } from "lucide-react";

function timeAgo(iso: string) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

export default function Header() {
  const { state, setSettingsOpen, setSelectedTaskId, setActiveTab } = useApp();
  const [notifOpen, setNotifOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  const unread = state.notifications.filter((n) => !n.read).length;
  const idle = state.agents.filter((a) => a.status === "idle").length;
  const working = state.agents.filter((a) => a.status === "working").length;
  const reviewCount = state.tasks.filter((t) => t.status === "review").length;
  const proposalCount = state.tasks.filter((t) => t.proposedByAgentId).length;
  const pendingDecisions = state.decisions.filter((d) => d.status === "pending").length;
  const actionNeeded = reviewCount + proposalCount + pendingDecisions;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (notifOpen && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (reviewOpen && reviewRef.current && !reviewRef.current.contains(e.target as Node)) {
        setReviewOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notifOpen, reviewOpen]);

  const reviewTasks = state.tasks.filter((t) => t.status === "review");
  const proposalTasks = state.tasks.filter((t) => t.proposedByAgentId);
  const pendingDecisionsList = state.decisions.filter((d) => d.status === "pending");

  async function markAllRead() {
    await api("PATCH", "/api/notifications/read");
  }

  return (
    <header className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-surface shrink-0 shadow-sm z-50">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 text-primary">
          <Activity size={18} />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">Agent Board</h1>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm text-text-secondary bg-background px-3 py-1.5 rounded-full border border-border">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-zinc-500"></span>
            <span>{idle} idle</span>
          </div>
          {working > 0 && (
            <>
              <span className="text-border">|</span>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot"></span>
                <span className="text-emerald-400">{working} working</span>
              </div>
            </>
          )}
          {actionNeeded > 0 && (
            <>
              <span className="text-border">|</span>
              <div className="relative" ref={reviewRef}>
                <button
                  className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                  onClick={() => setReviewOpen((o) => !o)}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse-dot"></span>
                  <span className="text-amber-400">{actionNeeded} need review</span>
                </button>
                {reviewOpen && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-3 w-[320px] max-h-[400px] overflow-hidden flex flex-col bg-surface border border-border rounded-xl shadow-xl z-50 animate-in fade-in scale-95 duration-100">
                    <div className="px-4 py-2.5 border-b border-border text-xs font-semibold text-text-secondary">
                      Items needing attention
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {reviewTasks.map((t) => {
                        const agent = state.agents.find((a) => a.id === t.assignedAgentId);
                        return (
                          <button
                            key={t.id}
                            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-left w-full hover:bg-surface-hover transition-colors border-b border-border last:border-0"
                            onClick={() => { setSelectedTaskId(t.id); setReviewOpen(false); }}
                          >
                            <Eye size={14} className="text-amber-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-text-primary">{t.title}</div>
                              {agent && <div className="text-xs text-text-tertiary">{agent.name}</div>}
                            </div>
                          </button>
                        );
                      })}
                      {proposalTasks.map((t) => {
                        const agent = state.agents.find((a) => a.id === t.proposedByAgentId);
                        return (
                          <button
                            key={t.id}
                            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-left w-full hover:bg-surface-hover transition-colors border-b border-border last:border-0"
                            onClick={() => { setSelectedTaskId(t.id); setReviewOpen(false); }}
                          >
                            <MessageSquare size={14} className="text-amber-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-text-primary">{t.title}</div>
                              {agent && <div className="text-xs text-text-tertiary">Proposed by {agent.name}</div>}
                            </div>
                          </button>
                        );
                      })}
                      {pendingDecisionsList.map((d) => {
                        const agent = state.agents.find((a) => a.id === d.agentId);
                        return (
                          <button
                            key={d.id}
                            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-left w-full hover:bg-surface-hover transition-colors border-b border-border last:border-0"
                            onClick={() => { setActiveTab("decisions"); setReviewOpen(false); }}
                          >
                            <HelpCircle size={14} className="text-amber-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-text-primary">{d.question}</div>
                              {agent && <div className="text-xs text-text-tertiary">{agent.name}</div>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="w-px h-6 bg-border mx-1"></div>

        {/* Notification bell */}
        <div className="relative" ref={dropdownRef}>
          <button
            className={`relative p-2 rounded-lg transition-colors duration-200 ${notifOpen ? "bg-surface-hover text-text-primary" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              }`}
            onClick={() => setNotifOpen((o) => !o)}
          >
            <Bell size={18} />
            {unread > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-surface"></span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute top-full right-0 mt-2 w-[380px] max-h-[480px] overflow-hidden flex flex-col bg-surface border border-border rounded-xl shadow-xl z-50 origin-top-right animate-in fade-in scale-95 duration-100">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface/50 backdrop-blur-sm">
                <span className="text-sm font-semibold">Notifications</span>
                {unread > 0 && (
                  <button
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
                    onClick={markAllRead}
                  >
                    <CheckCircle2 size={14} />
                    Mark all read
                  </button>
                )}
              </div>
              <div className="overflow-y-auto flex-1 overscroll-contain">
                {state.notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-text-tertiary flex flex-col items-center gap-2">
                    <Bell size={24} className="opacity-20" />
                    No notifications yet
                  </div>
                ) : (
                  state.notifications.slice(0, 30).map((n) => (
                    <div
                      key={n.id}
                      className={`px-4 py-3 border-b border-border last:border-0 text-sm transition-colors hover:bg-surface-hover/50 ${n.read ? "text-text-secondary" : "text-text-primary bg-primary/5"
                        }`}
                    >
                      <div className="flex gap-3">
                        <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${n.read ? 'bg-transparent' : 'bg-primary'}`} />
                        <div>
                          <p className="leading-snug">{n.message}</p>
                          <p className="text-text-tertiary mt-1 text-xs font-medium">
                            {timeAgo(n.createdAt)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Settings */}
        <button
          className="p-2 text-text-secondary rounded-lg hover:bg-surface-hover hover:text-text-primary transition-colors duration-200"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
