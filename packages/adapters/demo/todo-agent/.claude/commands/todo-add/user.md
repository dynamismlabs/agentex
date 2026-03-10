Create a new todo in the todo-agent demo.

Arguments: $ARGUMENTS

Parse the arguments:
- Everything before `--` or the first newline is the **title**
- Everything after `--` or the first newline is the **description** (optional)
- If no `--` separator, the entire argument is the title and description is empty

Steps:
1. Read `demo/todo-agent/data/todos.json` (create it as `[]` if missing, also create the `data/` directory if needed)
2. Generate a new todo object:
   ```json
   {
     "id": "todo_<timestamp>",
     "title": "<parsed title>",
     "description": "<parsed description>",
     "status": "pending",
     "createdAt": "<ISO timestamp>",
     "completedAt": null,
     "agentType": null,
     "runId": null,
     "agentResult": null
   }
   ```
3. Append it to the array and write back to `todos.json` (pretty-printed with 2-space indent)
4. Confirm: show the created todo's ID and title
