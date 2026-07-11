#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export MOCK_FORMAT=cursor
exec node "$DIR/mock-agent.mjs" "$@"
