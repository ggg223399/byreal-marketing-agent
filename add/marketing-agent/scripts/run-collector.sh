#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

export PATH="$HOME/.local/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true

cd "$PROJECT_DIR"

LOCK_FILE="/tmp/nanoclaw-collector.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

INTERVAL=$(grep 'polling_interval_minutes' config.yaml 2>/dev/null | head -1 | sed 's/.*: *//' | tr -d ' ')
INTERVAL=${INTERVAL:-5}

LOCK_FILE="/tmp/nanoclaw-collector-last-run"
NOW=$(date +%s)
if [ -f "$LOCK_FILE" ]; then
  LAST_RUN=$(cat "$LOCK_FILE")
  ELAPSED=$(( NOW - LAST_RUN ))
  INTERVAL_SECS=$(( INTERVAL * 60 ))
  if [ "$ELAPSED" -lt "$INTERVAL_SECS" ]; then
    exit 0
  fi
fi

echo "$NOW" > "$LOCK_FILE"

mkdir -p logs
echo "--- $(date -Iseconds) ---" >> logs/collector.log

COLLECTOR="dist/marketing-agent/collector/collect.js"
if [ ! -f "$COLLECTOR" ]; then
  echo "ERROR: $COLLECTOR not found. Run npm run build first." >> logs/collector.log
  exit 1
fi

for pipeline in mentions network trends crisis; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running $pipeline pipeline..." >> logs/collector.log
  if ! timeout 180 node "$COLLECTOR" --pipeline="$pipeline" >> logs/collector.log 2>&1; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARNING: $pipeline pipeline failed or timed out" >> logs/collector.log
  fi
  sleep 2
done
