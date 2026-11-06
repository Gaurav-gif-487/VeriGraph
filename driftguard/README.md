# DriftGuard

DriftGuard compares API clients with server definitions and reports drift between them. This directory holds the tool plus two validation studies.

## `driftguard-fixed/`

The TypeScript tool. Build and test:

```bash
cd driftguard-fixed
npm ci
npm test        # builds first; 275 tests
```

`client-parser.ts` detects `client.buildRequest(method, url, ...)`, an SDK-generator pattern found in `polarsource/polar` (before the fix, 369 of 370 client calls in that repo were unresolved). `ADDENDUM_polar.md` has the details and one open gap: server-side `APIRouter(prefix=...)` composition is likely not resolved in `python-parser.ts`.

## `c1_study/`

Retrospective study of the structural-coverage signal.

- `TEST_METHODOLOGY_C1_C2.md`: the study method.
- `PREREGISTRATION.md`: the labeling rule, written before data collection.
- `scan_fastapi_template.py` and `fastapi_template_scan.json`: a scan of all 83 non-merge commits touching `backend/app` in `fastapi/full-stack-fastapi-template`. Set `STUDY_REPO` to a local clone.
- `FINDINGS_C1.md`: result. 7 alerts and no `tested`-coverage examples, about two orders of magnitude short of the required 35 to 45 per group. The study is data-starved: neither validated nor falsified.

## `c2_sprt_verification/`

SPRT and resample-consistency experiments (`sprt_policy.py`, `sprt_experiment.py`, `run_experiment.py`, `harness.py`, `policies.py`, `stats_toolkit.py`). `FINDINGS_resample_consistency.md` and `FINDINGS_sprt_addendum.md` hold the results, reproducible with seed `20260822`. `pilot_harness.py` is a pilot driver configured through environment variables (`STUDY_REPO`, `DRIFTGUARD_CLI`, `COMMITS_FILE`, `PILOT_OUT`). It expects a clone of `fastapi/full-stack-fastapi-template` (it runs DriftGuard on `frontend/src` vs `backend/app`) and a `COMMITS_FILE` of tab-separated `<index>\t<commit>` lines, which is not included in this repo.

## Not done

- C1 prospective study (needs real calendar time).
- C2 calibration steps: they need a non-deterministic analysis, and DriftGuard is deterministic by design.
- The `python-parser.ts` router-prefix gap.
