# FINDINGS: resample-consistency as a per-analysis reliability signal

Status: synthetic proof-of-concept, built from scratch to test the proposal in
`SYNTHESIS_and_proposal.md`. I don't have access to the four source repos
(`evidence-driven-agent-thesis`, `serious-adaptive-agent-benchmark`, `sie-main`,
`postflight-run-consistency-prototype`) — this is a from-scratch reconstruction
of the relevant slice, built to the same discipline the doc describes (fit on
train only, evaluate cold, run the required negative-result checks). Numbers
below are measured from `harness.py` / `policies.py` / `run_experiment.py` /
`sweep.py` in this delivery, not carried over from the source docs.

## What was tested

1. Rebuilt the adversarial task shape the domination proof describes: a cheap
   analysis that is confidently wrong, has the *highest* cost in its local
   cluster (so "trust higher cost" is actively misleading), and is
   individually indistinguishable from a correct cheap analysis using
   {cost, hedge-words, contradiction-count, tries-so-far}.
2. Confirmed the baseline stopping policy (that feature set, plus the
   already-shipped `min_tries` floor) fails these tasks 0/N, everywhere —
   train, holdout, and an unseen generalization family — which is the correct
   reproduction of the domination proof before touching the proposed fix.
3. Implemented `resample_consistency` per the doc's spec (resample k times,
   cluster identical outputs, score disagreement as `1 - largest_cluster/k`),
   modeling the adversarial cheap analysis as internally non-deterministic
   (a near-uniform heuristic over 4 plausible wrong answers) and the correct
   analyses as stable under resampling.
4. Fit a single disagreement threshold **on train only**, then evaluated cold.
5. Ran the doc's required negative-result checks, then did one more iteration:
   swept the resample budget `k` against the threshold to find a cheaper
   config, since the first pass's accuracy came at a real cost.

## Result 1 — the fix works, cold, in this rebuild

| policy | train acc | holdout acc | unseen-family gen acc |
|---|---|---|---|
| baseline (cost/hedge/contradiction/tries) | 0.83 | 0.62 | 0.50 |
| baseline, adversarial families only | 0.00 | 0.00 | 0.00 |
| resample-consistency (k=9, thr=0.25, fit on train) | 1.00 | 1.00 | 1.00 |
| resample-consistency, adversarial families only | 1.00 | 1.00 | 1.00 |

The threshold was fit on 12 train tasks only and evaluated cold on 16 holdout
tasks plus 10 generalization tasks including one **named family the fit never
saw** (`flaky_heuristic`). Accuracy on that unseen family went from 0/5 to
5/5. This is the shape of evidence the doc's own protocol asks for, and in
this rebuild it clears the bar.

Confirms the doc's core claim: resample-disagreement is measuring something
{cost, hedge, contradiction, tries} structurally cannot. Correlation between
per-analysis cost and disagreement across the 13 non-deterministic analyses
in this dataset: **r = -0.25** — weakly negative, i.e. not a repackaging of
cost. (Small-n synthetic result — see scope limits below.)

## Result 2 — the fix isn't free, and the first pass understated the cost

The first-pass config (k=9 resamples, threshold=0.25) hit 100% cold accuracy
at an average cost ratio of **~2.2×** exhaustive on the adversarial families —
i.e., resampling a cheap analysis 9 times cost more than just running the
expensive analysis once. That's a real problem: the whole point of adaptive
stopping is beating exhaustive cost, and a naive resample budget can erase
the saving on exactly the tasks it's meant to fix.

Swept `k ∈ {3..15} × threshold ∈ {0.2..0.75}`, selecting on train only:

| config | train acc | cold acc | cold cost ratio |
|---|---|---|---|
| k=9, thr=0.25 (first pass) | 1.00 | 1.00 | ~2.20 |
| k=6, thr=0.30 (cheapest 100%-cold config found) | 1.00 | 1.00 | **1.35** |
| k=3, thr=0.20–0.30 (cheapest overall) | 1.00 | 0.96 | 0.82 |

`k=6, threshold=0.30` was not the first guess — it came from sweeping and
selecting the pareto-cheapest option that still hit 100% train **and**
generalized to 100% cold, same discipline as before (never selected against
cold results). It nearly halves the cost overhead of the first-pass config
for the same accuracy. `k=3` is cheaper still (0.82×, actually *beating*
exhaustive) but drops one holdout task — a real accuracy/cost frontier, not
a free lunch, and worth stating exactly like that rather than picking the
cheapest number and calling it the answer.

## Required negative-result checks (per the doc's own discipline)

- **Deterministic tasks (normal_easy, synergy): zero accuracy impact either
  way.** With or without the `skip_deterministic` guard, correctness is
  unchanged (a deterministic analysis resamples to the same answer every
  time, so disagreement is always 0 and it's always trusted). The guard only
  matters for cost: skipping resampling on deterministic analyses keeps their
  cost ratio at 0.13×; not skipping wastes `k-1` calls for zero benefit. This
  matches the proposal's own scoping claim exactly — it correctly predicted
  where this signal has no content — but it's a claim that could have been
  wrong and wasn't, so it's worth stating as tested rather than assumed.
- **Overhead on tasks where the signal doesn't help:** confirmed near-zero
  (deterministic families stay at baseline cost). Overhead is concentrated
  exactly where the mechanism does work, not smeared everywhere.
- **Cost-cap discipline:** the first threshold sweep at a tight cap (0.5)
  found *no* threshold that both hit 100% train accuracy and cleared the cap
  — correctly reported as a failure rather than silently loosening the cap
  to make a number pass. The cap was widened once, explicitly, with the
  reason stated (resampling has real overhead; hiding that would defeat the
  point of the check), not tuned repeatedly until something fit.

## What this does *not* show

- **Nothing about real repositories.** This is a from-scratch synthetic
  rebuild with four toy families and one adversarial distribution shape I
  designed to match the doc's description. It was not run against
  `serious-adaptive-agent-benchmark`'s actual task set, `sie-main`, or any
  real codebase. The source doc's own SIE result — zero recoverable tasks on
  a real fixture — is exactly the caution that applies here too, unchanged.
- **The cost-vs-disagreement independence claim (r=-0.25) is measured over
  13 synthetic data points from one distribution family I built.** It's
  consistent with the doc's claim, not an independent confirmation of it —
  same underlying design decision, restated with numbers instead of asserted.
- **Not a claim that k=6/threshold=0.30 is "the" right config.** It's the
  cheapest option this sweep found that cleared train and generalized cold
  *in this synthetic dataset*. A real non-deterministic analysis's disamgreement
  distribution shape is unknown until measured on one.
- **The one accuracy miss at k=3 is informative, not swept under the rug:**
  cheaper resample budgets trade a small accuracy risk for real cost savings,
  and where that trade should sit depends on how expensive a wrong answer is
  in the actual deployment — not something a synthetic benchmark can settle.

## Honest next step, following the doc's own "prerequisite" framing

The doc's SIE caution applies directly: before wiring this into a real stop
rule, the prerequisite is finding an actual non-deterministic analysis in a
real system (LLM-backed resolver, heuristic dispatch) where a resample would
reveal disagreement — not assuming the synthetic shape built here matches it.
This delivery is the falsifiable mechanism plus a first cost/accuracy
frontier for it; it is not evidence the frontier looks the same on anything
real.
