#!/bin/bash
# Mock `codex app-server`: records argv and the JSON-RPC requests it receives.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/mock-codex-app-server.mjs" "$@"
