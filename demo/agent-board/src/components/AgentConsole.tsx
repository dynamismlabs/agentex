import { useRef, useEffect, useCallback } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import { Send, TerminalSquare, Bot, Sparkles, Wrench, CheckCircle, RotateCcw, ExternalLink, Eye, MessageSquare, HelpCircle } from "lucide-react";

const eventClasses: Record<string, string> = {
  system: "text-zinc-500 italic",
  assistant: "text-zinc-200",
  thinking: "text-purple-400",
  tool_call: "text-blue-400",
  tool_result: "text-emerald-400",
  result: "text-amber-400 border-t border-zinc-800/50 pt-2 mt-2 font-medium",
};

function getEventIcon(type: string) {
  switch (type) {
    case "system": return <TerminalSquare size={14} className="mt-0.5 shrink-0" />;
    case "assistant": return <Bot size={14} className="mt-0.5 shrink-0" />;
    case "thinking": return <Sparkles size={14} className="mt-0.5 shrink-0" />;
    case "tool_call": return <Wrench size={14} className="mt-0.5 shrink-0" />;
    case "tool_result": return <CheckCircle size={14} className="mt-0.5 shrink-0" />;
    case "result": return <CheckCircle size={14} className="mt-0.5 shrink-0" />;
    default: return <TerminalSquare size={14} className="mt-0.5 shrink-0" />;
  }
}

function formatEvent(ev: Record<string, unknown>): { className: string; text: string; type: string } {
  const type = (ev.type as string) || "system";
  let className = eventClasses[type] ?? "text-zinc-500";
  let text = "";

  switch (type) {
    case "system":
      text = `[system] ${(ev.message as string) || (ev.subtype as string) || ""}`;
      break;
    case "assistant":
      text = (ev.text as string) || "";
      break;
    case "thinking":
      text = `[thinking] ${((ev.text as string) || "").slice(0, 200)}`;
      break;
    case "tool_call":
      text = `[tool] ${(ev.name as string) || ""} ${typeof ev.input === "string" ? ev.input.slice(0, 100) : ""}`;
      break;
    case "tool_result":
      text = `[result] ${((ev.content as string) || "").slice(0, 200)}`;
      if (ev.isError) className = "text-red-400";
      break;
    case "result":
      text = `[done] ${(ev.text as string) || ""} ${ev.cost != null ? "| $" + (ev.cost as number).toFixed(4) : ""}`;
      break;
    default:
      text = JSON.stringify(ev).slice(0, 200);
  }

  return { className, text, type };
}

export default function AgentConsole() {
  const { state, activeAgentId, setActiveAgentId, subscribeConsole, getConsoleBuffer, initConsoleBuffer, openTerminalTab, setSelectedTaskId, setActiveTab } = useApp();
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const appendToDOM = useCallback(
    (ev: unknown) => {
      const el = outputRef.current;
      if (!el) return;

      const { className, text, type } = formatEvent(ev as Record<string, unknown>);

      const div = document.createElement("div");
      div.className = `flex gap-2.5 mb-2.5 ${className}`;

      // We can't easily append React components via DOM manipulation, 
      // so we'll just use simple HTML for the icons or text
      let iconHtml = '';
      if (type === 'system') iconHtml = '>';
      else if (type === 'assistant') iconHtml = '🤖';
      else if (type === 'thinking') iconHtml = '✨';
      else if (type === 'tool_call') iconHtml = '🔧';
      else if (type === 'tool_result') iconHtml = '✓';
      else if (type === 'result') iconHtml = '🏁';
      else iconHtml = '>';

      div.innerHTML = `<div class="shrink-0 opacity-50 text-[10px] mt-0.5 w-4 text-center">${iconHtml}</div><div class="flex-1 break-words">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;

      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    },
    [],
  );

  // Load buffer from API on agent switch
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    el.innerHTML = "";

    api<unknown[]>("GET", `/api/agents/${activeAgentId}/console`).then(
      (events) => {
        initConsoleBuffer(activeAgentId, events);
        for (const ev of events) {
          appendToDOM(ev);
        }
      },
    );
  }, [activeAgentId, appendToDOM, initConsoleBuffer]);

  // Subscribe to live events
  useEffect(() => {
    return subscribeConsole((agentId, event) => {
      if (agentId === activeAgentId) {
        appendToDOM(event);
      }
    });
  }, [activeAgentId, subscribeConsole, appendToDOM]);

  async function handleSend() {
    const msg = inputRef.current?.value.trim();
    if (!msg) return;
    inputRef.current!.value = "";

    // Show in console
    const el = outputRef.current;
    if (el) {
      const div = document.createElement("div");
      div.className = "flex gap-2.5 mb-2.5 text-blue-400";
      div.innerHTML = `<div class="shrink-0 opacity-50 text-[10px] mt-0.5 w-4 text-center">👤</div><div class="flex-1 break-words">[you] ${msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    }

    await api("POST", `/api/agents/${activeAgentId}/message`, { message: msg });
  }

  async function handleNewSession() {
    await api("POST", `/api/agents/${activeAgentId}/new-session`);
    const el = outputRef.current;
    if (el) el.innerHTML = "";
  }

  function handleOpenInTerminal() {
    const agent = state.agents.find((a) => a.id === activeAgentId);
    if (!agent?.sessionParams) return;
    const sessionId = (agent.sessionParams as Record<string, unknown>)?.sessionId as string | undefined;
    if (!sessionId) return;
    const cwd = (agent.sessionParams as Record<string, unknown>)?.cwd as string | undefined;
    openTerminalTab({
      label: `${agent.name} session`,
      cwd,
      command: ["claude", "--resume", sessionId],
    });
  }

  // Derive "needs attention" per agent from task + decision state
  function attentionCount(agentId: string): number {
    const reviews = state.tasks.filter((t) => t.assignedAgentId === agentId && t.status === "review").length;
    const proposals = state.tasks.filter((t) => t.proposedByAgentId === agentId).length;
    const decisions = state.decisions.filter((d) => d.agentId === agentId && d.status === "pending").length;
    return reviews + proposals + decisions;
  }

  const anyNeedsAttention = state.agents.some((a) => attentionCount(a.id) > 0);

  return (
    <div className={`w-[440px] flex flex-col shrink-0 border-l bg-surface shadow-[-4px_0_24px_-12px_rgba(0,0,0,0.5)] z-10 transition-colors duration-500 ${anyNeedsAttention ? "border-amber-500/60" : "border-border"}`}>
      {/* Agent tabs */}
      <div className="flex items-center border-b border-border bg-background/50 backdrop-blur-md">
        <div className="flex-1 flex overflow-x-auto hide-scrollbar">
          {state.agents.map((a) => {
            const count = attentionCount(a.id);
            const needsAttention = count > 0;
            const isActive = activeAgentId === a.id;
            const dotClass =
              a.status === "working"
                ? "bg-emerald-500 animate-pulse-dot shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                : needsAttention
                  ? "bg-amber-400 animate-pulse-dot shadow-[0_0_8px_rgba(251,191,36,0.6)]"
                  : "bg-zinc-600";

            let tabClass: string;
            if (needsAttention && !isActive) {
              tabClass = "text-amber-400 border-amber-400 bg-amber-400/10 animate-subtle-pulse";
            } else if (needsAttention && isActive) {
              tabClass = "text-amber-400 border-amber-400 bg-amber-400/5";
            } else if (isActive) {
              tabClass = "text-primary border-primary bg-primary/5";
            } else {
              tabClass = "text-text-secondary border-transparent hover:text-text-primary hover:bg-surface-hover";
            }

            return (
              <button
                key={a.id}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tabClass}`}
                onClick={() => setActiveAgentId(a.id)}
              >
                <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
                {a.name}
                {needsAttention && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/20 text-amber-400 font-semibold tabular-nums">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {(() => {
          const agent = state.agents.find((a) => a.id === activeAgentId);
          const hasSession = agent?.status === "idle" && !!(agent.sessionParams as Record<string, unknown> | null)?.sessionId;
          return hasSession ? (
            <button
              className="px-2 py-2 text-text-tertiary hover:text-primary transition-colors shrink-0"
              onClick={handleOpenInTerminal}
              title="Open session in terminal"
            >
              <ExternalLink size={14} />
            </button>
          ) : null;
        })()}
        <button
          className="px-3 py-2 text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
          onClick={handleNewSession}
          title="New session (clear console)"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Output */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-relaxed bg-[#0a0a0c]"
      />

      {/* Action items for active agent */}
      {(() => {
        const reviewTasks = state.tasks.filter((t) => t.assignedAgentId === activeAgentId && t.status === "review");
        const proposals = state.tasks.filter((t) => t.proposedByAgentId === activeAgentId);
        const pendingDecisions = state.decisions.filter((d) => d.agentId === activeAgentId && d.status === "pending");
        const items = [...reviewTasks, ...proposals, ...pendingDecisions];
        if (items.length === 0) return null;
        return (
          <div className="px-3 pt-2 pb-1 border-t border-amber-500/30 bg-amber-500/5">
            <div className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold mb-1.5">Needs your attention</div>
            <div className="flex flex-col gap-1">
              {reviewTasks.map((t) => (
                <button
                  key={t.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 rounded-lg transition-colors text-left w-full"
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <Eye size={12} className="shrink-0" />
                  <span className="truncate flex-1">Review: {t.title}</span>
                </button>
              ))}
              {proposals.map((t) => (
                <button
                  key={t.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 rounded-lg transition-colors text-left w-full"
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <MessageSquare size={12} className="shrink-0" />
                  <span className="truncate flex-1">Proposal: {t.title}</span>
                </button>
              ))}
              {pendingDecisions.map((d) => (
                <button
                  key={d.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 rounded-lg transition-colors text-left w-full"
                  onClick={() => setActiveTab("decisions")}
                >
                  <HelpCircle size={12} className="shrink-0" />
                  <span className="truncate flex-1">Decision: {d.question}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Input */}
      <div className="p-3 border-t border-border bg-surface">
        <div className="relative flex items-center">
          <input
            ref={inputRef}
            className="w-full pl-4 pr-12 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-text-tertiary shadow-inner"
            placeholder="Send message to agent..."
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <button
            className="absolute right-1.5 p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
            onClick={handleSend}
            title="Send Message"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
