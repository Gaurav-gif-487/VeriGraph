# Component 1 (Structural Coverage Signal) — Retrospective Study

Status: **Retrospective mining infeasible on this repo set. Reported as a
negative/scoping result, not silently dropped.**

## What was done

1. Pre-registered the labeling rule (`PREREGISTRATION.md`) before touching
   any data, per `TEST_METHODOLOGY_C1_C2.md` §0.1/§1.2.
2. Built `driftguard-fixed` for real (`npm install && npm run build`),
   confirmed `dist/cli.js` works.
3. Cloned all 5 real repos from the original VALIDATION.md dogfood.
4. Confirmed base contract-graph detection works correctly (non-`check`
   mode finds real client↔server matches, e.g.
   `POST /api/v1/login/access-token` in `full-stack-fastapi-template`).
5. Mechanically walked **all 83 non-merge commits** touching `backend/app`
   across `full-stack-fastapi-template`'s full ~2.5-year, 1497-commit
   history (`scan_fastapi_template.py`) — the deepest of the 5 repos and
   therefore the best-case candidate for reaching the required n.

## Result

| metric | value |
|---|---|
| commits scanned | 83 (100%) |
| commits with any detected contract change | 6 |
| total individual alerts | 7 |
| alerts with a `perImpactRisk` coverage verdict | 4 (2 BREAKING, 2 WARNING) |
| coverage=`tested` alerts observed | **0** |
| coverage=`untested` alerts observed | 2 |
| coverage=`cannot_determine` alerts observed | 2 |
| required per TEST_METHODOLOGY_C1_C2.md §1.3 | ~35–45 per group (large effect) |

Two initially-promising commits were manually checked and turned out to be
correctly-non-breaking (a pure Python class rename `ItemOut`→`ItemPublic`
with an unchanged wire schema, and an additive-only field) — confirming the
detector's quietness on those commits is *correct behavior*, not a
detection gap. The 7 real alerts found are genuine.

**One operational bug found and logged, not fixed yet:** commit `8558cf0`
(2024-03-07, the earliest in the touching-backend/app set) failed with
`fatal: pathspec 'frontend/src' did not match any files` — `git archive`
can't find `frontend/src` because the repo's directory layout hadn't
stabilized that early in its history. A real retrospective scanner needs a
per-commit path-existence guard; this one didn't have it yet.

## Conclusion

Even with exhaustive, mechanical (non-cherry-picked) scanning of the
deepest available repo, real n is **off by roughly two orders of
magnitude** from TEST_METHODOLOGY_C1_C2.md §1.3's requirement, and there
are zero `tested`-coverage examples to compare against at all — the 2×2
table this study needs literally cannot be filled in from this data.

This is not a claim that Component 1's underlying thesis is false. It is a
claim that **retrospective mining of small-to-medium real repos cannot
supply enough naturally-occurring breaking changes** to test it
statistically, which the pre-registration's own §1.3 anticipated as a
possibility and §3 explicitly required reporting honestly rather than
running the test anyway on n=4 and calling it validated.

## Recommended next step (not yet done)

Per the two options raised when this scan was scoped: either (a) source
repos with an order of magnitude more relevant history (large, long-lived
production APIs), or (b) switch to the prospective design (§1.2), which
takes real calendar time but doesn't have this ceiling. Neither has been
started. C1 remains **not validated, not falsified — data-starved**, and
should be reported as such, not folded into either conclusion.
