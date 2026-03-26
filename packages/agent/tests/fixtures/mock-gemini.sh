#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export MOCK_FORMAT=gemini
exec node "$DIR/mock-agent.mjs"
