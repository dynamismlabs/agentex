#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/mock-agy.mjs" "$@"
