Create a new todo in the todo-agent demo.

Arguments: $ARGUMENTS

1. Parse the arguments:
   - Everything before `--` or the first newline is the **title**
   - Everything after `--` or the first newline is the **description** (optional, defaults to "")
   - If no arguments are provided, ask the user for a title

2. Read `examples/todo-agent/data/todos.json` (create it as `[]` if it doesn't exist)

3. Generate a new todo object:
   ```json
   {
     "id": "todo_{Date.now()}",
     "title": "<parsed title>",
     "description": "<parsed description>",
     "status": "pending",
     "createdAt": "<current ISO timestamp>",
     "completedAt": null,
     "agentType": null,
     "runId": null,
     "agentResult": null
   }
   ```

4. Append it to the array and write the file back (with 2-space JSON indentation)

5. Confirm: "Created todo `<id>`: <title>"
