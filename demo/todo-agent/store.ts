import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "todos.json");

export interface Todo {
  id: string;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  completedAt: string | null;
  agentType: "claude" | "codex" | null;
  runId: string | null;
  agentResult: {
    exitCode: number | null;
    summary: string | null;
    costUsd: number | null;
    model: string | null;
    errorMessage: string | null;
    durationMs: number;
  } | null;
}

export function readTodos(): Todo[] {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeTodos(todos: Todo[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2));
}

export function getTodo(id: string): Todo | undefined {
  return readTodos().find((t) => t.id === id);
}

export function addTodo(title: string, description: string): Todo {
  const todos = readTodos();
  const todo: Todo = {
    id: `todo_${Date.now()}`,
    title,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    agentType: null,
    runId: null,
    agentResult: null,
  };
  todos.push(todo);
  writeTodos(todos);
  return todo;
}

export function updateTodo(id: string, patch: Partial<Todo>): Todo | null {
  const todos = readTodos();
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const existing = todos[idx];
  if (!existing) return null;
  const updated: Todo = { ...existing, ...patch };
  todos[idx] = updated;
  writeTodos(todos);
  return updated;
}

export function deleteTodo(id: string): boolean {
  const todos = readTodos();
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return false;
  writeTodos(filtered);
  return true;
}
