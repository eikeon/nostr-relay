#!/bin/bash
set -e
cd "$(dirname "$0")/.."

RELAY_PORT=8182 pnpm run dev &
for i in $(seq 1 10); do
  sleep 1
  if lsof -ti :8182 >/dev/null 2>&1; then
    kill $(lsof -ti :8182) 2>/dev/null
    echo "Smoke test complete"
    exit 0
  fi
done
echo "Smoke test failed: relay did not start on port 8182"
exit 1
