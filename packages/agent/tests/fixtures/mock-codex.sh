#!/bin/bash
# Mock Codex CLI — ignores all args, delegates to mock-agent.mjs with codex format.
# When MOCK_DUMP_ARGS_TO is set, writes one argv element per line to that path
# before delegating, so tests can assert on what flags were passed.
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$MOCK_DUMP_ARGS_TO" ]; then
  : > "$MOCK_DUMP_ARGS_TO"
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$MOCK_DUMP_ARGS_TO"
  done
fi
export MOCK_FORMAT=codex
exec node "$DIR/mock-agent.mjs"
