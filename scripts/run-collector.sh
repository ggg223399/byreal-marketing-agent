#!/bin/bash
# Collector runner for cron — sets up environment properly
set -euo pipefail

PROJECT_DIR="/home/james/Work/Apps/byreal-marketing-agent"
LOG_FILE="$PROJECT_DIR/logs/collector.log"
NODE_BIN="/home/james/.nvm/versions/node/v24.13.1/bin"
CLAUDE_BIN="/home/james/.local/bin"

export PATH="$NODE_BIN:$CLAUDE_BIN:$PATH"

cd "$PROJECT_DIR"

# Load environment variables
set -a
source .env
set +a

# Run collector with timestamp
echo "--- $(date -Iseconds) ---" >> "$LOG_FILE"
npx tsx collector/collect.ts >> "$LOG_FILE" 2>&1
