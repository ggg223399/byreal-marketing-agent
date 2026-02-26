#!/bin/bash
# Collector runner for cron — sets up environment properly
# PROJECT_DIR is auto-detected from script location (scripts/ → marketing-agent/ → NanoClaw root)
#
# Cron should run every minute:  * * * * * /path/to/run-collector.sh
# Actual collection interval is controlled by polling_interval_minutes in config.yaml
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"    # scripts/ → marketing-agent/ → NanoClaw root
NODE_BIN="$(dirname "$(which node)" 2>/dev/null)"    # auto-detect from PATH; override if needed
CLAUDE_BIN="$(dirname "$(which claude)" 2>/dev/null)" # claude CLI needed by classifier

export PATH="$NODE_BIN:$CLAUDE_BIN:$PATH"
unset CLAUDECODE 2>/dev/null || true  # prevent nested-session error when called from Claude Code

cd "$PROJECT_DIR"

# Load environment variables
set -a
source .env
set +a

# Read polling_interval_minutes from config.yaml (default 5)
INTERVAL=$(grep 'polling_interval_minutes' config.yaml 2>/dev/null | head -1 | sed 's/.*: *//' | tr -d ' ')
INTERVAL=${INTERVAL:-5}

# Check last run timestamp to respect polling interval
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

# Record this run
echo "$NOW" > "$LOCK_FILE"

mkdir -p logs

# Run collector with timestamp
echo "--- $(date -Iseconds) ---" >> logs/collector.log
npx tsx marketing-agent/collector/collect.ts >> logs/collector.log 2>&1
