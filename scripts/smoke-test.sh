#!/bin/bash
set -e
cd "$(dirname "$0")/.."

RELAY_PORT=8182 npm run dev &
sleep 3
if ! lsof -ti :8182 >/dev/null 2>&1; then
  echo "Smoke test failed: relay did not start on port 8182"
  exit 1
fi
kill $(lsof -ti :8182) 2>/dev/null
echo "Smoke test complete"
