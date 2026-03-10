Execute a todo from the todo-agent demo using an AI agent.

Arguments: $ARGUMENTS

Parse the arguments:
- First argument: todo ID (e.g., `todo_1234567890`) or a partial title to match
- Second argument (optional): agent type — `claude` or `codex` (defaults to `claude`)

Steps:
1. Read `demo/todo-agent/data/todos.json` and find the matching todo by ID or partial title match
2. If not found, list available todos and ask the user to pick one
3. If found, run the execution script:
   ```bash
   cd demo/todo-agent && npx tsx run-todo.ts <todoId> <agentType>
   ```
4. The script will stream output and update the store automatically
5. After completion, report the result (status, duration, cost, token usage, summary)
