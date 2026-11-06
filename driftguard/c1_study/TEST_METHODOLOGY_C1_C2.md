# Test Methodology — Validating C1 and C2 to a Statistical Standard

Both acceptance criteria in the v2 doc say the same thing in different words:
*not another synthetic scenario, measured against real outcomes.* That's a
statistics problem, not an engineering problem — a single live run is a smoke test, not evidence. This doc is the method for turning
"it ran once and worked" into "we have a defensible estimate of how well this
generalizes."

One discipline governs both components, borrowed directly from the codebase's
own `SPRTGate.ts` (`assertNoTrainColdLeakage`): **fit on train, evaluate cold,
never let the two overlap.** Everything below is built around that split,
because it's the difference between a validated result and a result that
looks validated because it was tuned to look that way.

---

## 0. Ground rules that apply to both components

1. **Pre-register what counts as "real breakage" / "reliable" before
   collecting data.** If the definition is decided after looking at results,
   every number downstream is contaminated by hindsight. Write the labeling
   rule down first (see §1.2 / §2.2), then apply it mechanically.

2. **Train/cold split, no exceptions.** Whatever data is used to pick
   thresholds, tune the heuristic, or estimate p0/p1 must never appear in the
   set used to report the final number. This is already enforced in code for
   C2 (`assertNoTrainColdLeakage`); C1 needs the same discipline applied
   manually to the evaluation process, since there's no equivalent guard in
   `TestCoverageResolver.ts` today.

3. **Report intervals, not points.** "83% accuracy" from n=12 and "83%
   accuracy" from n=400 are not the same claim. Every metric below gets a
   confidence interval. A point estimate with no interval is not a
   statistical result — it's a data point.

4. **Generalization requires ≥2 independent sources.** One repo, one
   codebase, one non-deterministic analysis — however real — is a case
   study, not a generalizing result. The doc's own distinction between
   "fixture" and "real" implicitly demands this: a single real instance is
   one step better than a fixture, not the same thing as "generalizes."
   Minimum bar: results replicate in the same direction across at least two
   independent repos (C1) or two independent non-deterministic decisions
   (C2) before calling it validated.

---

## 1. Component 1 — Structural Coverage Signal

**Claim being tested:** *"untested" classification predicts real breakage
better than chance, at a magnitude worth acting on.*

### 1.1 What the test actually is

This is a **binary classifier evaluated against a binary outcome** — a
2×2 contingency table problem, not a vague "does it seem to work" question.

|  | Actually broke | Didn't break |
|---|---|---|
| Flagged `untested` | a | b |
| Flagged `tested` | c | d |

Everything downstream (precision, recall, significance) comes from filling in
this table honestly, which means fixing the labeling rule *before* filling it
in.

### 1.2 Ground-truth labeling rule (fix this first)

Pick one, write it down, don't change it mid-study:

- **Retrospective:** for each historical drift alert `driftguard check`
  would have raised, did the corresponding consumer file need a follow-up
  fix within N days/commits after the flagged change landed (bug report,
  hotfix commit touching that file, revert)? N should be fixed in advance
  (e.g. 14 days) — picking N after seeing the data is the exact hindsight
  contamination §0.1 warns about.
- **Prospective:** run `driftguard check` on every PR in a live window,
  record the per-alert coverage verdict at merge time, then check N days
  later whether that consumer needed a fix. Slower to collect, no
  survivorship bias from picking which historical incidents to look at.

Prospective is the stronger design (no risk of selectively remembering which
past incidents to check) but takes real calendar time. Retrospective is
usable now if the labeling rule is applied mechanically to *all* qualifying
alerts in the window, not cherry-picked ones.

### 1.3 Sample size — how much data is actually needed

n=3 (the original dogfood) and n=1 (a single live run) are both far
below the threshold to say anything statistically. For a two-proportion
comparison (breakage rate among `untested` alerts vs. `tested` alerts) at a
conventional 80% power, 5% significance, to detect a **large** effect (say,
40% breakage rate among untested vs. 10% among tested — roughly what the
original n=3 dogfood suggested), you need on the order of **35–45 alerts per
group** (~70–90 total). To detect a more modest, still-actionable effect
(25% vs. 10%), that climbs to roughly **120–150 per group**. These are
back-of-envelope numbers from a standard two-proportion power calculation —
run the actual calculation (e.g. `statsmodels.stats.power.NormalIndPower` in
Python, or an equivalent) once a target effect size is chosen, rather than
treating the numbers above as fixed.

Practical implication: **a handful of alerts from one repo cannot clear this
bar.** The path to a real n is running `driftguard check` continuously across
PRs (or replaying commit history) on real repositories over weeks, not a
single seeded scenario.

### 1.4 The actual statistical test

Once the 2×2 table is filled in from real, unbiased data:

- **Fisher's exact test** (preferred over chi-square at small/moderate n,
  exact rather than asymptotic) on the 2×2 table — null hypothesis: coverage
  verdict and breakage outcome are independent. Reject at your chosen
  significance level (0.05 is conventional; report the actual p-value, don't
  just say "significant").
- **Effect size, not just significance:** report the risk ratio
  `P(broke | untested) / P(broke | tested)` with a confidence interval
  (Katz log method or bootstrap). Significance without effect size answers
  "is there *any* signal" — it doesn't answer "is this worth triaging on."
- **Confidence intervals on each cell proportion:** use Wilson score
  intervals, not the naive normal approximation — naive intervals misbehave
  badly at the sample sizes this is likely to actually have (dozens, not
  thousands).
- **`cannot_determine` gets reported separately, never folded into either
  bucket.** If it's silently merged into "tested" or "untested," the
  resulting number describes a system that doesn't exist. Report its own
  breakage rate and its own row in the table.

### 1.5 Generalization protocol

- Run the identical protocol on **at least 2 structurally different real
  repositories** (different frameworks/languages if possible — the resolver
  already covers TS barrel exports, Python, Go). If the effect holds in the
  same direction with overlapping confidence intervals across both, that's
  the first real evidence of generalization. If it holds in one and not the
  other, the honest conclusion is "works in [context X], unproven in
  [context Y]" — not "works."
- Stratify by alert type (`BREAKING`/`WARNING`/`UNKNOWN`) and report the
  contingency table per stratum in addition to pooled — an aggregate result
  can hide the coverage signal working well for one severity and not at all
  for another.

---

## 2. Component 2 — SPRT-Gated Resample Budget

**Claim being tested (once a real non-deterministic analysis is found — see
prior status doc):** *the gate reproduces the target error rates (alpha,
beta) and achieves cold accuracy parity with the existing fixed-budget
approach, at lower cost.*

The nice property here: `SPRTGate.ts` and `calibrateP0P1` are already built to
be evaluated this way — the statistical structure just needs real inputs.

### 2.1 Calibration set requirements

`calibrateP0P1` needs `(analysis, label)` pairs where `label` is decided
**externally**, not by resampling itself — otherwise the estimate is circular
(the code's own docstring flags this). Concretely: run the real
non-deterministic analysis, get its answer, verify that answer against
independent ground truth (not against a repeated sample of itself), label it
`reliable`/`unreliable` from that verification. Only then hand it to
`calibrateP0P1`.

- **Minimum viable calibration set:** the code technically runs with 1
  example per label, but that gives a point estimate of p0/p1 with no
  statistical grounding. For a defensible estimate, aim for **≥20 labeled
  examples per class**, each resampled `n_pairs_per_example` times (the
  existing default of 20 pairs is reasonable; more pairs narrows the CI on
  p0/p1 for a fixed number of examples, but doesn't substitute for more
  distinct examples — see 2.3).
- Compute a **confidence interval on p0 and p1 themselves** (Wilson interval,
  since each is a proportion estimated from a binomial count of matches).
  `calibrateP0P1`'s existing guard (`0 < p0 < p1 < 1`) checks the point
  estimates don't invert — it doesn't check whether the *interval* around p0
  overlaps the interval around p1. If the CIs overlap substantially, the
  calibration is statistically indistinguishable from noise even though the
  point estimates happen to satisfy the guard. This is worth adding as an
  explicit check before trusting a calibration.

### 2.2 Ground-truth labeling for "reliable" vs "unreliable"

Same discipline as C1 §1.2 — fix the rule first:

- Run the real analysis once, get an answer.
- Verify that answer against an independent source of truth (existing test
  suite outcome, human review, a slower/more expensive verified method) —
  something that isn't just "run the same analysis again," or the labeling
  and the resampling measure the same thing and the calibration is circular.
- Label `reliable` if verified-correct, `unreliable` if verified-incorrect.

### 2.3 Cold evaluation — the actual test

This is where the code's existing negative-result checks
(`checkDeterministicOverhead`, `checkCostCap`, `assertNoTrainColdLeakage`)
get run against real data instead of the synthetic harness:

1. **Split labeled examples into train/cold before doing anything else.**
   Calibrate `p0`/`p1` on train only.
2. **Run `SPRTGate.decide()` on every cold example.** For each, you now have
   (predicted verdict, true label).
3. **Empirical error rate check:** among cold examples whose true label is
   `unreliable`, what fraction did the gate call `reliable` (false accept of
   H1 — this is the empirical analog of alpha)? Among cold examples whose
   true label is `reliable`, what fraction did the gate call `unreliable`
   (empirical beta)? Compute an exact binomial confidence interval on each
   (Clopper-Pearson, since these are rare-event proportions the normal
   approximation handles poorly) and check it's consistent with the design
   targets (alpha=0.05, beta=0.05 by default). "Consistent with" means the
   design value falls inside the empirical CI — not that the point estimate
   exactly matches it.
4. **Cost comparison:** compare mean resample cost under SPRT vs. the
   existing fixed-budget approach on the *same cold set*, paired (same
   examples, both methods), and report a paired comparison (e.g. Wilcoxon
   signed-rank, since cost distributions are unlikely to be normal) rather
   than just comparing two means.
5. **Sample size for the cold set:** to get a Clopper-Pearson CI on a
   proportion near 5% (the target alpha/beta) tight enough to actually
   distinguish "5%" from "15%," you need on the order of **60–100 cold
   examples per class minimum**, more if the true rate turns out to sit
   right at the boundary of what's acceptable. Fewer than that and the CI is
   wide enough to be consistent with almost anything, which isn't a
   validation — run the actual Clopper-Pearson width calculation once a
   target precision is chosen.

### 2.4 Existing checks, now run for real

- `checkDeterministicOverhead` — feed it real deterministic instances of the
  analysis (if any exist) from the cold set; confirm cost ratio is exactly
  1.0 as designed.
- `checkCostCap` — compute the real cold cost ratio and confirm it's within
  the cap multiplier of the real baseline cost, not the synthetic one.
- `assertNoTrainColdLeakage` — call this on the actual train/cold ID sets
  before reporting anything. If it throws, the study is invalid and needs
  to be redone with a real split, not patched.

### 2.5 Generalization protocol

- The synthetic harness result (100% cold accuracy) is one data point on one
  synthetic task family. A single real non-deterministic analysis, even
  validated per §2.3, is the *second* data point — still not "generalizes."
- To claim generalization: find and validate against **≥2 independent real
  non-deterministic decisions** (e.g., an LLM-backed resolver and a separate
  heuristic dispatch, per the doc's own examples in §3). If both clear
  §2.3's checks with overlapping conclusions, that's the actual evidence
  the doc's Phase Next gate (§4, "Component 2 has produced at least one real
  calibration cycle worth fitting on") is asking for before C4 (continuous
  calibration loop) even becomes eligible to start.

---

## 3. What this rules out as "testing"

To be explicit about what does *not* clear either bar, since it's tempting to
round up:

- A single live run against one seeded fixture change (a single earlier run) — smoke test, not validation.
- Reporting a percentage with no confidence interval.
- Tuning the coverage heuristic or SPRT thresholds on the same data used to
  report the final accuracy/error-rate number.
- Calling one repo or one non-deterministic decision "generalizes."
- Any number where the underlying n is in the single digits (n=3, n=1) —
  report it as anecdote, not evidence, until the sample size in §1.3/§2.3
  is actually met.

## 4. Suggested order of operations

1. Fix the labeling rules (§1.2, §2.2) in writing before collecting data.
2. Stand up continuous `driftguard check` logging on ≥2 real repos (C1) —
   this is the actual bottleneck; everything else is downstream of having
   the data.
3. In parallel, find and instrument ≥1 real non-deterministic decision for
   C2, per the prior status doc's open item.
4. Once each has enough labeled outcomes (§1.3/§2.3 sample sizes), run the
   fixed statistical tests above — do not adjust the test after seeing
   partial results.
5. Report point estimate + CI + p-value/effect size for each, per repo/decision
   and pooled, with `cannot_determine`/deterministic cases broken out
   separately, not folded in.
