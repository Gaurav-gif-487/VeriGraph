# GuardRuntime / VeriGraph experiments

A collection of research prototypes and experiment trails around runtime verification of AI-agent behavior: failure-hazard modelling (VeriGraph), API-drift detection (DriftGuard), and mutation testing on `ky`.

This is research code: several results come from synthetic data and say so. For example, `causal-test` v1 is circular by construction; v2 and v3 fix that (see `verigraph/README.md`).

## Projects

| Folder | What it is | Verify with |
|---|---|---|
| `verigraph/` | Stock/flow + logistic-hazard verification debt model, CLI, MCP server, React dashboard, Python port | `npm test` (18 tests), `npm run typecheck`, `npm run build` |
| `driftguard/` | DriftGuard (`driftguard-fixed/`) plus C1/C2 validation studies | `npm test` (275 tests; builds first) |
| `ky-mutation-testing-project/` | Fork of `ky` used for Stryker mutation testing | `npx ava test/http-error.ts`; full run: `npm run mutation` (30-40 min) |
| `step3b_addendum_and_data/` | Mutation-testing addendum, config, and raw Stryker JSON reports | read its [`README.md`](step3b_addendum_and_data/README.md) |

## Quick start

Requires Node >= 22.

```bash
scripts/test-all.sh                 # install + test every project (CI runs the same)
scripts/test-all.sh verigraph       # or just one
./run_all.sh                        # run the VeriGraph experiment commands
```

VeriGraph CLI:

```bash
cd verigraph && npm ci
npx tsx cli/verigraph.ts benchmark
npx tsx cli/verigraph.ts analyze datasets/swe_bench_verified_fixtures.json
npx tsx cli/verigraph.ts causal-test-v3 30     # trials is positional, not --trials
```

## Notes

- Dataset caveat: `verigraph/datasets/swe_bench_verified_fixtures.json` is 25 hand-written synthetic traces, not real SWE-bench runs.
- The two Python study scripts in `driftguard/` need a local clone of the repo under study; set `STUDY_REPO` (see script headers).
- Unfinished work: the last `normalize.ts` mutants in `step3b_addendum_and_data/`, and validation of the causal-centrality hypothesis on real agent traces.
- Licensing: the repository is MIT (see `LICENSE`). `driftguard-fixed/` has its own MIT license file, and `ky-mutation-testing-project/` keeps ky's original MIT license (Sindre Sorhus).
- Perfect scores (AUROC 1.000) in VeriGraph's ablation come from 25 small, hand-written synthetic traces. They show the pipeline runs end to end, not that the method works on real agent traces.

GuardRuntime and SIE live in their own repositories.
