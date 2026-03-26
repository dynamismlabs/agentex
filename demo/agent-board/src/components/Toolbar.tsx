import { useApp } from "../AppContext";
import { api } from "../api";
import type { AppState } from "../../types";
import { LayoutList, Kanban, Plus, Database, ListTodo, StickyNote, GitBranch, TerminalSquare, Puzzle } from "lucide-react";

const TABS = [
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "decisions", label: "Decisions", icon: GitBranch },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "skills", label: "Skills", icon: Puzzle },
] as const;

export default function Toolbar() {
  const {
    activeTab,
    setActiveTab,
    activeView,
    setActiveView,
    setAddTaskOpen,
    setState,
  } = useApp();

  async function handleSeed() {
    await api("POST", "/api/tasks/seed");
    const data = await api<AppState>("GET", "/api/state");
    setState(data);
  }

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-surface shrink-0 z-0">
      <div className="flex bg-background p-1 rounded-lg border border-border">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${isActive
                ? "bg-surface text-text-primary shadow-sm"
                : "text-text-secondary hover:text-text-primary hover:bg-surface/50"
                }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={16} className={isActive ? "text-primary" : ""} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {activeTab === "tasks" && (
        <div className="flex bg-background p-1 rounded-lg border border-border">
          <button
            className={`flex items-center justify-center p-1.5 w-8 h-8 rounded-md transition-all duration-200 ${activeView === "list"
              ? "bg-surface text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-primary hover:bg-surface/50"
              }`}
            onClick={() => setActiveView("list")}
            title="List View"
          >
            <LayoutList size={16} />
          </button>
          <button
            className={`flex items-center justify-center p-1.5 w-8 h-8 rounded-md transition-all duration-200 ${activeView === "kanban"
              ? "bg-surface text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-primary hover:bg-surface/50"
              }`}
            onClick={() => setActiveView("kanban")}
            title="Kanban View"
          >
            <Kanban size={16} />
          </button>
        </div>
      )}

      <div className="w-px h-6 bg-border mx-1"></div>

      <button
        className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        onClick={handleSeed}
      >
        <Database size={16} />
        Seed
      </button>
      <button
        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-black rounded-lg text-sm font-medium shadow-sm transition-colors"
        onClick={() => setAddTaskOpen(true)}
      >
        <Plus size={16} />
        Add Task
      </button>
    </div>
  );
}
