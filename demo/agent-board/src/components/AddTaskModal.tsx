import { useState } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import type { Task } from "../../types";
import { Plus, X } from "lucide-react";

export default function AddTaskModal() {
  const { state, setState, addTaskOpen, setAddTaskOpen } = useApp();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [areaId, setAreaId] = useState("");
  const [goalId, setGoalId] = useState("");

  if (!addTaskOpen) return null;

  async function handleSubmit() {
    if (!title.trim() || !description.trim()) return;
    const task = await api<Task>("POST", "/api/tasks", {
      title: title.trim(),
      description: description.trim(),
      priority,
      areaId,
      goalId: goalId || null,
    });
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, task] }));
    setTitle("");
    setDescription("");
    setPriority("medium");
    setAreaId("");
    setGoalId("");
    setAddTaskOpen(false);
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200"
      onClick={(e) => e.target === e.currentTarget && setAddTaskOpen(false)}
    >
      <div className="bg-surface border border-border rounded-2xl p-6 w-[520px] max-w-[90vw] shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary/10 text-primary rounded-lg">
              <Plus size={18} />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">New Task</h2>
          </div>
          <button
            className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
            onClick={() => setAddTaskOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Title</label>
            <input
              className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-text-tertiary"
              placeholder="What needs to be done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Description</label>
            <textarea
              className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-text-tertiary h-24 resize-y"
              placeholder="Provide context and details for the agent..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Priority</label>
              <select
                className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all appearance-none"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Area</label>
              <select
                className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all appearance-none"
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
              >
                <option value="">None</option>
                {state.areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Goal</label>
            <select
              className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all appearance-none"
              value={goalId}
              onChange={(e) => setGoalId(e.target.value)}
            >
              <option value="">None</option>
              {state.goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-8">
          <button
            className="px-4 py-2 border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            onClick={() => setAddTaskOpen(false)}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-black rounded-lg text-sm font-medium shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!title.trim() || !description.trim()}
          >
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}
