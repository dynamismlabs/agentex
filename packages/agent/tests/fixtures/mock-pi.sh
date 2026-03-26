#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export MOCK_FORMAT=pi
exec node "$DIR/mock-agent.mjs"
