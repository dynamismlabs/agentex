import { useState, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import { useApp } from "../AppContext";
import { api } from "../api";
import type { Note } from "../../types";
import { Plus, Trash2, Edit3, Eye, FileText } from "lucide-react";

function timeAgo(iso: string) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

export default function NotesPanel() {
  const { state, setState } = useApp();
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(true);
  const [content, setContent] = useState("");
  const saveTimer = useRef<number>();

  const note = state.notes.find((n) => n.id === activeNoteId);

  // Load content on note selection
  useEffect(() => {
    if (!activeNoteId) return;
    api<{ content: string }>("GET", `/api/notes/${activeNoteId}/content`).then(
      (r) => setContent(r.content || ""),
    );
  }, [activeNoteId]);

  function handleContentChange(val: string) {
    setContent(val);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api("PUT", `/api/notes/${activeNoteId}/content`, { content: val });
    }, 500);
  }

  async function createNote() {
    const n = await api<Note>("POST", "/api/notes", { title: "Untitled note" });
    setState((prev) => ({ ...prev, notes: [...prev.notes, n] }));
    setActiveNoteId(n.id);
    setContent(`# Untitled note\n\n`);
    setEditMode(true);
  }

  async function renameNote(title: string) {
    if (!activeNoteId) return;
    await api("PATCH", `/api/notes/${activeNoteId}`, { title });
    setState((prev) => ({
      ...prev,
      notes: prev.notes.map((n) =>
        n.id === activeNoteId ? { ...n, title } : n,
      ),
    }));
  }

  async function deleteNote() {
    if (!activeNoteId) return;
    await api("DELETE", `/api/notes/${activeNoteId}`);
    setState((prev) => ({
      ...prev,
      notes: prev.notes.filter((n) => n.id !== activeNoteId),
    }));
    setActiveNoteId(null);
  }

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar */}
      <div className="w-[260px] border-r border-border flex flex-col bg-surface/30 shrink-0">
        <div className="p-4 border-b border-border">
          <button
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-black rounded-lg text-sm font-medium transition-colors shadow-sm"
            onClick={createNote}
          >
            <Plus size={16} />
            New Note
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {state.notes.length === 0 && (
            <div className="text-center text-text-tertiary text-sm p-4 mt-4">
              No notes yet
            </div>
          )}
          {state.notes.map((n) => {
            const area = state.areas.find((a) => a.id === n.areaId);
            const isActive = n.id === activeNoteId;
            return (
              <div
                key={n.id}
                className={`px-4 py-3 cursor-pointer rounded-lg text-sm transition-all duration-200 ${isActive
                  ? "bg-primary/10 text-primary"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  }`}
                onClick={() => {
                  setActiveNoteId(n.id);
                  setEditMode(true);
                }}
              >
                <div className="font-medium flex items-center gap-2 mb-1">
                  {area ? (
                    <span
                      className="w-2 h-2 rounded-full shrink-0 shadow-sm"
                      style={{ background: area.color, boxShadow: `0 0 6px ${area.color}80` }}
                    />
                  ) : (
                    <FileText size={14} className={isActive ? "text-primary" : "text-text-tertiary"} />
                  )}
                  <span className="truncate">{n.title}</span>
                </div>
                <div className={`text-[11px] pl-4 ${isActive ? "text-primary/70" : "text-text-tertiary"}`}>
                  {timeAgo(n.updatedAt)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {!note ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <div className="w-16 h-16 mb-4 rounded-full bg-surface-hover flex items-center justify-center">
              <FileText size={24} className="opacity-50" />
            </div>
            <p className="text-sm font-medium text-text-secondary">No note selected</p>
            <p className="text-xs mt-1">Select a note from the sidebar or create a new one</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-4 px-6 py-4 border-b border-border bg-surface/50 backdrop-blur-sm">
              <input
                className="flex-1 bg-transparent border-none text-lg font-semibold text-text-primary outline-none placeholder:text-text-tertiary"
                value={note.title}
                onChange={(e) => renameNote(e.target.value)}
                placeholder="Note title..."
              />
              <div className="flex bg-background p-1 rounded-lg border border-border">
                <button
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${editMode
                    ? "bg-surface text-text-primary shadow-sm"
                    : "text-text-tertiary hover:text-text-primary hover:bg-surface/50"
                    }`}
                  onClick={() => setEditMode(true)}
                >
                  <Edit3 size={14} />
                  Edit
                </button>
                <button
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${!editMode
                    ? "bg-surface text-text-primary shadow-sm"
                    : "text-text-tertiary hover:text-text-primary hover:bg-surface/50"
                    }`}
                  onClick={() => setEditMode(false)}
                >
                  <Eye size={14} />
                  Preview
                </button>
              </div>
              <div className="w-px h-6 bg-border mx-1"></div>
              <button
                className="p-2 text-text-tertiary hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                onClick={deleteNote}
                title="Delete Note"
              >
                <Trash2 size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden relative">
              {editMode ? (
                <textarea
                  className="absolute inset-0 w-full h-full p-6 bg-transparent text-text-primary border-none outline-none font-mono text-sm leading-relaxed resize-none custom-scrollbar"
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  placeholder="Start typing your note here..."
                />
              ) : (
                <div className="absolute inset-0 overflow-y-auto p-8 custom-scrollbar">
                  <div className="max-w-3xl mx-auto prose prose-invert prose-zinc prose-sm">
                    <Markdown>{content}</Markdown>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
