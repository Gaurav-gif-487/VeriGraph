# Phase 1, Component 1 — closed against the real repo

`src/graph/TestCoverageResolver.ts` — dependency-free (fs/path only) port of
the validated Python resolver: barrel/re-export resolution (unbounded depth,
transparent) + indirect coverage via a shared hook/utility (bounded-hop BFS).
Same algorithm, same two named gaps closed, now real TypeScript in the real
package.

`src/risk/PerImpactRisk.ts` — `calculateRiskPerImpact()`, additive to
`RiskEngine.calculateRisk` (untouched, still the aggregate `ImpactEngine`
calls for the summary line). Ranks impacts by a coverage-weighted RPN.

`test/per-impact-risk.test.ts` — runs the real, unmodified `ContractGraph` /
`ImpactEngine.evaluateImpact` / `RiskEngine.calculateRisk` against the real
`fixtures/frontend` workspace. `fixtures/frontend/src/__tests__/userClient.test.ts`
is one seeded test file (matching the fixture repo's own DRIFTED/seeded-
scenario convention) added so there's a genuine tested-vs-untested contrast
to resolve, rather than every consumer coming back untested by construction.

Result on the real fixtures, three real BREAKING changes:

```
Aggregate (unmodified RiskEngine.calculateRisk): score=48 level=MEDIUM

Per-impact (new calculateRiskPerImpact):
  contract:settings    BREAKING   coverage=untested   rpn=900.0
  contract:profile     BREAKING   coverage=untested   rpn=900.0
  contract:users       BREAKING   coverage=tested      rpn=90.0
```

One score for three alerts hides that two of three have zero test coverage
and one is fully covered — the exact gap the dogfood named. Per-impact
scoring makes the priority order visible.

## Update: wired into the CLI, re-validated live, SPRT ported

The gaps above are closed as of this pass:

- **Wired into `src/cli.ts`.** `calculateRiskPerImpact` was a tested library
  function nobody's `driftguard check`/`driftguard impact` run ever
  surfaced — confirmed by grepping `cli.ts` for any reference to it (zero
  hits) before this change. It's now called in both commands and rendered
  in `text`, `json`, and `markdown` output (`formatPerImpactRiskText` /
  `formatPerImpactRiskMarkdown` in `cli.ts`). **Not** wired into `sarif`
  output — SARIF's schema is fixed for CI code-scanning annotations and
  per-impact RPN doesn't map onto it naturally; that's a deliberate,
  documented omission, not a quiet gap. The `receipt` command still doesn't
  surface it either.

- **Verified with a real install:** `npm install && npm run
  build`, then built a throwaway git repo from `fixtures/frontend` /
  `fixtures/backend`, committed a real breaking change on top
  (`Profile.verified: boolean -> string`), and ran the compiled
  `dist/cli.js` against it — not hand-built `ContractGraph` objects. Real
  `GraphBuilder` output, real coverage computed by `ModuleGraph` walking the
  actual fixture files, real `PER-IMPACT RISK` table in the output:

  ```
  PER-IMPACT RISK (highest priority first)
  CONTRACT  CONSUMER  FIELDS  COVERAGE  RPN
  contract:GET:/api/v1/profile/:id  frontend/src/hooks/useProfile.ts  1  untested  1000.0
  ```

  Confirmed the same field is present as `perImpactRisk` in `--format=json`.

- **5 new regression tests added to `test/cli.test.ts`** (which had zero
  coverage of the `check` subcommand before this pass) — a real two-commit
  git history with a genuine tested/untested consumer contrast, asserting
  the untested consumer outranks the tested one by RPN, across
  text/json/markdown for `check` and json for `impact`. Full suite: 259 ->
  272 tests, all passing; build is clean.

- **Component 2 (SPRT gate) ported to TypeScript** — `src/risk/SPRTGate.ts`
  is a 1:1 behavioral port of `evidence-gated-phase1/sprt_policy.py` +
  `sprt/gate.py` (Wald's SPRT, `calibrateP0P1`, `SPRTGate`, and the three
  negative-result checks: deterministic-overhead, cost-cap,
  train/cold-leakage). `test/sprt-gate.test.ts` ports all 7 of
  `tests/test_sprt_gate.py`'s cases plus a minimal TS re-implementation of
  `harness.py`'s synthetic task generator, and reproduces the addendum's
  headline 100%-cold-accuracy result through the ported/wrapped machinery —
  confirming the port didn't silently change behavior. This is a real,
  tested module now, not a Python-only prototype.

  **Still open, and it's a data problem now, not a code problem:** deploying
  `SPRTGate` against a live DriftGuard decision needs (a) a decision with an
  actual resampling operation, and (b) a REAL labeled calibration set
  (`calibrateP0P1` explicitly refuses synthetic stand-ins for either — see
  its docstring). The `--threshold` fuzzy dynamic-route classifier
  (`route-matcher.ts`, `HeuristicRouteClassifier.score()`) was evaluated as
  the candidate named below and rejected for now: it's a pure deterministic
  function of two route templates, so there's no "resample the same
  analysis again" operation to gate without manufacturing one (e.g.
  injected scoring jitter) — and wiring a manufactured resampling scheme
  into real drift-detection output, ungrounded in a real calibration set,
  would be worse than leaving it unwired. Finding or instrumenting a
  genuinely non-deterministic DriftGuard decision, and collecting labeled
  correct/incorrect outcomes for it from real repos, remains the open
  acceptance criterion — same as the original Python delivery's own stated
  scope, just now with a ported TS gate ready to receive it.
