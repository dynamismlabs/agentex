import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter, listAdapters } from "../../packages/adapters/src/index.js";
import type { StreamEvent } from "../../packages/adapters/src/index.js";
import { readTodos, getTodo, addTodo, updateTodo, deleteTodo } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
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

// Check adapter availability
app.get("/api/adapters", async (_req, res) => {
  const available: Record<string, boolean> = {};
  for (const name of listAdapters()) {
    try {
      const adapter = getAdapter(name);
      const result = await adapter.testEnvironment({ adapterType: name });
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

  const runId = `todo-${id}-${Date.now()}`;
  updateTodo(id, { status: "running", agentType, runId });
  runningTodoId = id;

  // Return immediately, execute async
  res.status(202).json({ runId });

  // Start execution in background
  executeAgent(id, agentType, runId, todo.title, todo.description);
});

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------
async function executeAgent(
  todoId: string,
  agentType: "claude" | "codex",
  runId: string,
  title: string,
  description: string
) {
  const adapter = getAdapter(agentType);
  const startTime = Date.now();

  const prompt = `Task: ${title}\n\nDetails: ${description}`;

  broadcastEvent(todoId, {
    type: "system",
    data: { message: `Starting ${agentType} agent...`, timestamp: new Date().toISOString() },
  });

  try {
    const result = await adapter.execute({
      runId,
      prompt,
      cwd: process.cwd(),
      config: {
        skipPermissions: true,
        maxTurns: 5,
        timeoutSec: 120,
      },
      onEvent: (event: StreamEvent) => {
        broadcastEvent(todoId, { type: event.type, data: event });
      },
    });

    const durationMs = Date.now() - startTime;
    const success = result.exitCode === 0;

    updateTodo(todoId, {
      status: success ? "done" : "failed",
      completedAt: new Date().toISOString(),
      agentResult: {
        exitCode: result.exitCode,
        summary: result.summary,
        costUsd: result.costUsd,
        model: result.model,
        errorMessage: result.errorMessage,
        durationMs,
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
        durationMs,
      },
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
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
        durationMs,
      },
    });

    broadcastEvent(todoId, {
      type: "done",
      data: { status: "failed", errorMessage, durationMs },
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
