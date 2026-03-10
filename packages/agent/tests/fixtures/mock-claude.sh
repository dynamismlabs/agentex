#!/bin/bash
# Mock Claude CLI — ignores all args, delegates to mock-agent.mjs
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/mock-agent.mjs"
