#!/bin/bash
# Weekly consolidation job for Keymaker
# Runs memory consolidation: pattern detection, memory strengthening, weekly digest, monthly snapshots

set -e

KEYMAKER_DIR="/opt/keymaker/keymaker"
LOG_FILE="/var/log/keymaker-consolidate.log"

echo "========================================" >> "$LOG_FILE"
echo "$(date): Starting weekly consolidation" >> "$LOG_FILE"

cd "$KEYMAKER_DIR"

# Source environment
export $(grep -v '^#' .env | xargs)

# Run consolidation
npm exec tsx src/cli.ts consolidate >> "$LOG_FILE" 2>&1

echo "$(date): Consolidation complete" >> "$LOG_FILE"
