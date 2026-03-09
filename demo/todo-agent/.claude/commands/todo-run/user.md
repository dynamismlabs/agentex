Execute a todo with an AI agent using the todo-agent demo.

Arguments: $ARGUMENTS

1. Parse arguments: the first argument is the **todo ID** (or a partial title to search for). An optional second argument is the **agent type** (`claude` or `codex`, defaults to `claude`).

2. Read `examples/todo-agent/data/todos.json` and find the matching todo:
   - Match by exact ID first (e.g. `todo_1234567890`)
   - If no exact match, search by partial title (case-insensitive)
   - If no match found, show available todos and ask the user to pick one

3. If the todo status is not `pending`, warn: "Todo is already <status>. Run anyway?" and wait for confirmation.

4. Run the execution script:
   ```bash
   cd examples/todo-agent && npx tsx run-todo.ts <todoId> <agentType>
   ```

5. After execution completes, read the updated todo from `examples/todo-agent/data/todos.json` and report:
   - Status (done/failed)
   - Agent summary or error message
   - Duration
   - Cost (if available)
