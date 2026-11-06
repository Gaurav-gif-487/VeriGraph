#!/usr/bin/env bash
# Install dependencies and run the test / typecheck suite of every project.
# Usage: scripts/test-all.sh [project ...]   (default: all)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

declare -A CMDS=(
  [verigraph]="npm run typecheck && npm test && npm run build"
  [driftguard/driftguard-fixed]="npm test"
)
ORDER=(verigraph driftguard/driftguard-fixed)
[ "$#" -gt 0 ] && ORDER=("$@")

fail=0
for p in "${ORDER[@]}"; do
  echo; echo "=================== $p ==================="
  ( cd "$ROOT/$p" && npm ci --no-audit --no-fund && bash -c "${CMDS[$p]}" ) || { echo "FAILED: $p"; fail=1; }
done
echo; [ "$fail" = 0 ] && echo "All projects passed." || { echo "Some projects failed."; exit 1; }
