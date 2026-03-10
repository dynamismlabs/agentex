import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { getProvider, listProviders } from "../../packages/agent/src/index.js";
import type { StreamEvent } from "../../packages/agent/src/index.js";
import { readTodos, getTodo, addTodo, updateTodo, deleteTodo, clearTodos, seedTodos } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const app = express();
const PORT = 3456;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ---------------------------------------------------------------------------
// SSE connections: todoId -> Set of response objects
// ---------------------------------------------------------------------------
const sseClients = new Map<string, Set<express.Response>>();

function broadcastEvent(todoId: string, event: { type: string; data: unknown }) {
  const clients = sseClients.get(todoId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function closeAllClients(todoId: string) {
  const clients = sseClients.get(todoId);
  if (!clients) return;
  for (const res of clients) {
    res.write(`data: ${JSON.stringify({ type: "close" })}\n\n`);
    res.end();
  }
  sseClients.delete(todoId);
}

// ---------------------------------------------------------------------------
// Track currently running execution
// ---------------------------------------------------------------------------
let runningTodoId: string | null = null;

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// List all todos
app.get("/api/todos", (_req, res) => {
  res.json(readTodos());
});

// Create a todo
app.post("/api/todos", (req, res) => {
  const { title, description } = req.body;
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const todo = addTodo(title.trim(), (description || "").trim());
  res.status(201).json(todo);
});

// Delete a todo
app.delete("/api/todos/:id", (req, res) => {
  const { id } = req.params;
  if (runningTodoId === id) {
    res.status(409).json({ error: "Cannot delete a running todo" });
    return;
  }
  if (!deleteTodo(id)) {
    res.status(404).json({ error: "Todo not found" });
    return;
  }
  res.json({ ok: true });
});

// Clear all todos
app.delete("/api/todos", (_req, res) => {
  if (runningTodoId) {
    res.status(409).json({ error: "Cannot clear while a task is running" });
    return;
  }
  clearTodos();
  res.json({ ok: true });
});

// Seed demo todos
app.post("/api/todos/seed", (_req, res) => {
  const created = seedTodos();
  res.status(201).json(created);
});

// SSE stream for execution events
app.get("/api/todos/:id/events", (req, res) => {
  const { id } = req.params;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  if (!sseClients.has(id)) {
    sseClients.set(id, new Set());
  }
  sseClients.get(id)!.add(res);

  req.on("close", () => {
    sseClients.get(id)?.delete(res);
  });
});

// Check provider availability
app.get("/api/providers", async (_req, res) => {
  const available: Record<string, boolean> = {};
  for (const name of listProviders()) {
    try {
      const provider = getProvider(name);
      const result = await provider.testEnvironment({ providerType: name });
      available[name] = result.status !== "fail";
    } catch {
      available[name] = false;
    }
  }
  res.json(available);
});

// Execute a todo with an agent
app.post("/api/todos/:id/execute", (req, res) => {
  const { id } = req.params;
  const { agentType } = req.body;

  if (!agentType || !["claude", "codex"].includes(agentType)) {
    res.status(400).json({ error: "agentType must be 'claude' or 'codex'" });
    return;
  }

  const todo = getTodo(id);
  if (!todo) {
    res.status(404).json({ error: "Todo not found" });
    return;
  }

  if (runningTodoId) {
    res.status(409).json({ error: "Another task is already running" });
    return;
  }

  updateTodo(id, { status: "running", agentType });
  runningTodoId = id;

  // Return immediately, execute async
  res.status(202).json({ ok: true });

  // Start execution in background
  executeAgent(id, agentType, todo.title, todo.description);
});

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------
async function executeAgent(
  todoId: string,
  agentType: "claude" | "codex",
  title: string,
  description: string
) {
  const provider = getProvider(agentType);

  const workspaceDir = join(DATA_DIR, "workspace", todoId);
  mkdirSync(workspaceDir, { recursive: true });

  const prompt = `Task: ${title}\n\nDetails: ${description}`;

  broadcastEvent(todoId, {
    type: "system",
    data: { message: `Starting ${agentType} agent...`, timestamp: new Date().toISOString() },
  });

  try {
    const result = await provider.execute({
      prompt,
      cwd: workspaceDir,
      config: {
        skipPermissions: true,
        maxTurns: 5,
        timeoutSec: 120,
      },
      onEvent: (event: StreamEvent) => {
        broadcastEvent(todoId, { type: event.type, data: event });
      },
    });

    const success = result.exitCode === 0;

    updateTodo(todoId, {
      status: success ? "done" : "failed",
      runId: result.runId,
      completedAt: result.completedAt,
      agentResult: {
        exitCode: result.exitCode,
        summary: result.summary,
        costUsd: result.costUsd,
        model: result.model,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
        usage: result.usage ?? null,
      },
    });

    broadcastEvent(todoId, {
      type: "done",
      data: {
        status: success ? "done" : "failed",
        exitCode: result.exitCode,
        summary: result.summary,
        costUsd: result.costUsd,
        model: result.model,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
        usage: result.usage ?? null,
      },
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    updateTodo(todoId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      agentResult: {
        exitCode: null,
        summary: null,
        costUsd: null,
        model: null,
        errorMessage,
        durationMs: 0,
        usage: null,
      },
    });

    broadcastEvent(todoId, {
      type: "done",
      data: { status: "failed", errorMessage, durationMs: 0 },
    });
  } finally {
    runningTodoId = null;
    closeAllClients(todoId);
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Todo Agent demo running at http://localhost:${PORT}`);
});
