#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export MOCK_FORMAT=opencode
exec node "$DIR/mock-agent.mjs" "$@"
