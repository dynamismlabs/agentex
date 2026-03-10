Read the file `demo/todo-agent/data/todos.json` and display all todos in a formatted table.

Show columns: ID, Title, Status, Agent, Duration, Cost, Summary.

- If the file doesn't exist or is empty, say "No todos yet."
- Use checkmarks/crosses for status: pending ○, running ◉, done ✓, failed ✗
- Show duration in seconds if available
- Show cost as $X.XXXX if available
- Truncate summary to 60 chars
