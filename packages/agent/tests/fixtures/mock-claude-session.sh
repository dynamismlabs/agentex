#!/bin/bash
# Mock Claude CLI in session mode — stays alive for multi-turn ndjson
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/mock-claude-session.mjs"
