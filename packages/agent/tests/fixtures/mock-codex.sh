#!/bin/bash
# Mock Codex CLI — ignores all args, delegates to mock-agent.mjs with codex format
DIR="$(cd "$(dirname "$0")" && pwd)"
export MOCK_FORMAT=codex
exec node "$DIR/mock-agent.mjs"
