#!/bin/bash
# On-demand collector — runs only if trigger file exists, then removes it.
# Add to cron: * * * * * /path/to/collect-on-demand.sh
set -euo pipefail

TRIGGER="/home/claw/nanoclaw/data/collect-trigger"
[ -f "$TRIGGER" ] || exit 0
rm -f "$TRIGGER"

exec /home/claw/nanoclaw/scripts/run-collector.sh
