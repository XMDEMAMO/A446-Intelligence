#!/usr/bin/env sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PID_FILE="$PROJECT_ROOT/var/demo-pids"
if [ ! -f "$PID_FILE" ]; then
  printf '%s\n' 'No demo PID file found.'
  exit 0
fi

while IFS= read -r PID; do
  COMMAND=$(ps -p "$PID" -o command= 2>/dev/null || true)
  case "$COMMAND" in
    *node*"$PROJECT_ROOT"*) kill "$PID" && printf 'Stopped PID %s\n' "$PID" ;;
    '') ;;
    *) printf 'Skipped PID %s: command does not belong to this project.\n' "$PID" ;;
  esac
done <"$PID_FILE"
rm -f "$PID_FILE"

\n