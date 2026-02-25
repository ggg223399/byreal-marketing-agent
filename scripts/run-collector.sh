#!/bin/bash
# Collector runner for cron — sets up environment properly
# Edit PROJECT_DIR and NODE_BIN to match your installation.
set -euo pipefail

PROJECT_DIR="$HOME/nanoclaw"                       # ← adjust to your NanoClaw root
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
npx tsx collector/collect.ts >> logs/collector.log 2>&1
