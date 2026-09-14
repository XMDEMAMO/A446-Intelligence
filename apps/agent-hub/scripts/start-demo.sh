#!/usr/bin/env sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VAR_DIR="$PROJECT_ROOT/var"
LOG_DIR="$VAR_DIR/process-logs"
mkdir -p "$LOG_DIR"

node "$PROJECT_ROOT/src/mock-hub-cli.mjs" --config "$PROJECT_ROOT/config/hub.local.json" >"$LOG_DIR/hub.out.log" 2>"$LOG_DIR/hub.err.log" &
HUB_PID=$!
sleep 1
node "$PROJECT_ROOT/src/worker-cli.mjs" --config "$PROJECT_ROOT/config/agent-a.mock.json" >"$LOG_DIR/agent-a.out.log" 2>"$LOG_DIR/agent-a.err.log" &
AGENT_A_PID=$!
node "$PROJECT_ROOT/src/worker-cli.mjs" --config "$PROJECT_ROOT/config/agent-b.mock.json" >"$LOG_DIR/agent-b.out.log" 2>"$LOG_DIR/agent-b.err.log" &
AGENT_B_PID=$!
printf '%s\n' "$HUB_PID" "$AGENT_A_PID" "$AGENT_B_PID" >"$VAR_DIR/demo-pids"
printf 'Demo started: hub=%s agent-a=%s agent-b=%s\n' "$HUB_PID" "$AGENT_A_PID" "$AGENT_B_PID"
printf '%s\n' 'Loopback demo is unauthenticated unless HUB_TOKEN was already exported.'
printf '%s\n' "Run: node src/hubctl.mjs send --agent agent-a --input 'hello' --route agent-b --wait"
printf '%s\n' "Stop: ./scripts/stop-demo.sh"
