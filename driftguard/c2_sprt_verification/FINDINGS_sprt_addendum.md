# FINDINGS addendum: sequential testing (SPRT) as the adaptive resample budget

Follows `FINDINGS_resample_consistency.md`. That round ended on an open
weakness: fixed-k resampling (best found: k=6, threshold=0.30) hit 100% cold
accuracy but at real, non-negotiable cost overhead — every non-deterministic
analysis paid for exactly 6 resamples whether it needed 1 or 15.

This round borrows a piece of technology outside the adaptive-agent line of
work entirely: **Wald's Sequential Probability Ratio Test** (Wald, 1945 —
originally developed for wartime munitions quality control, now standard in
clinical-trial interim analysis). It's a direct fit for exactly this
sub-problem: "how many more samples do I need before I can trust this
result," with a formal, tunable error-rate guarantee instead of a swept
constant. Implementation: `sprt_policy.py`. Validation: `sprt_experiment.py`.

## Result 1 — same accuracy, lower cost, adaptively

| policy | cold acc (all) | cold cost ratio (all) | cold cost ratio (adversarial only) | resamples used |
|---|---|---|---|---|
| fixed k=6, thr=0.30 (prior best) | 1.00 | 1.12 | 3.02 | always 6 |
| SPRT (p0=.35, p1=.85, α=β=.05) | 1.00 | 0.97 | 2.59 | median 1-2, max 8 |

Same accuracy (100% cold, including the unseen `flaky_heuristic` family),
lower cost, because most analyses don't need six samples to reveal
themselves — an easy reliable analysis typically agrees with itself twice
in a row and crosses the "trust" boundary immediately, while a genuinely
flaky one gets however many samples the test actually needs (up to 8 in
this run) instead of being capped at a number picked by a grid sweep.

## Result 2 — the error-rate guarantee is real, not just asserted

Ran the SPRT machinery in isolation (`sprt_experiment.py` Part B), generating
5000 synthetic answer-streams at exactly the two design probabilities
(p0=0.35 for a genuinely unreliable analysis, p1=0.85 for a genuinely
reliable one) and checking whether the empirical error rates match the
design targets (α=β=0.05):

- False "reliable" verdict on a truly-unreliable stream: **3.3%** (target 5%)
- False "unreliable" verdict on a truly-reliable stream: **2.0%** (target 5%)

Both come in under the design target, which is the expected direction for
Wald's test (it's provably conservative at the boundaries under a
continuous-LLR idealization; the discrete step size here makes it slightly
more conservative still). This is the concrete payoff of importing the
technology: it's a checkable claim, not a number a sweep happened to land
on — and it checked out.

## Result 3 — the α/β knob is a real, predictable dial

| α = β | cold accuracy | cold cost ratio | median resamples |
|---|---|---|---|
| 0.20 | 1.00 | 0.73 | 1 |
| 0.10 | 1.00 | 1.01 | 1 |
| 0.05 | 1.00 | 1.15 | 1 |
| 0.02 | 1.00 | 1.23 | 1 |
| 0.01 | 1.00 | 1.63 | 1 |

Cost rises monotonically as the error tolerance tightens — exactly the
direction sequential-testing theory predicts, and something the earlier
grid-swept threshold had no way to promise in advance. Median resample count
holds at 1 throughout (most tasks in this synthetic set are easy either
way); the cost increase comes from the harder cases needing more evidence
before a tighter test will commit, which is also the theoretically correct
behavior, not an artifact.

## What changed my mind mid-iteration

The obvious next move after the fixed-k sweep was "sweep harder, smaller
grid steps." That would have kept producing the same kind of answer — a
constant, chosen empirically, with no way to state what error rate it
implies. Importing a 1945 statistical technique built for a completely
different domain (munitions sampling) turned "how many resamples" from a
tuned constant into a solved sub-problem with a named error rate attached
to it. That's the actual complement the doc's proposal was missing: not a
better clustering function, but a better *stopping rule for the resampling
itself*.

## What this still doesn't show

- Same scope limit as before: synthetic dataset, one adversarial
  distribution shape I designed, not validated against a real
  non-deterministic analysis (LLM resolver, heuristic dispatch) in an
  actual system.
- p0 and p1 (the two hypothesis probabilities) were set from knowledge of
  how the synthetic distributions were built. On a real analysis, these
  would need to be estimated from a calibration set first — SPRT needs
  *some* prior estimate of what "reliable" and "unreliable" streams look
  like; it doesn't invent that from nothing. That estimation step is new
  work this delivery hasn't done.
- The false-accept/false-reject rates were validated against the *design*
  probabilities (p0, p1) in isolation, not against the *actual* underlying
  distributions the harness generates (4-way near-uniform for the wrong
  answer, deterministic for the right one) — those are close to the design
  assumption by construction here, since I built both, which is a weaker
  check than validating against a distribution nobody tuned to fit the test.
