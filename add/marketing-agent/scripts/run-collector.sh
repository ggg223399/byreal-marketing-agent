#!/bin/bash
# Collector runner for cron — sets up environment properly
# PROJECT_DIR is auto-detected from script location (scripts/ → marketing-agent/ → NanoClaw root)
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

mkdir -p logs

# Run collector with timestamp
echo "--- $(date -Iseconds) ---" >> logs/collector.log
npx tsx marketing-agent/collector/collect.ts >> logs/collector.log 2>&1
