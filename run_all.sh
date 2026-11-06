#!/usr/bin/env bash
# Runs the VeriGraph experiments. Requires Node >= 22 and network access for `npm ci`.
# For tests/typechecks only, use scripts/test-all.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== verigraph =="
cd "$ROOT/verigraph" && npm ci --no-audit --no-fund
npx tsx cli/verigraph.ts benchmark
npx tsx cli/verigraph.ts analyze datasets/swe_bench_verified_fixtures.json | head -40
# NOTE: trials is a positional argument (`causal-test 30`), not `--trials 30`.
# v1 is circular by construction (see verigraph/README.md); v2/v3 are the falsifiable versions.
npx tsx cli/verigraph.ts causal-test 30
npx tsx cli/verigraph.ts causal-test-v2 30
npx tsx cli/verigraph.ts causal-test-v3 30

echo
echo "Done."

