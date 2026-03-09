List all todos from the todo-agent demo.

1. Read the file `examples/todo-agent/data/todos.json`
   - If the file doesn't exist or is empty, say "No todos yet. Use /todo-add to create one."
2. Present the todos as a formatted markdown table with these columns:
   - **ID** — the todo id
   - **Title** — the todo title
   - **Status** — pending, running, done, or failed
   - **Agent** — the agentType (claude/codex) or "—" if not set
   - **Result** — a short summary: the agent result summary if done, error message if failed, "—" otherwise
3. After the table, show a count: "X todos (Y pending, Z done, W failed)"
