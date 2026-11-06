"""
Bringing in outside technology #1: Wald's Sequential Probability Ratio Test
(Wald, 1945) applied to per-analysis resampling.

The previous round's weakness: fixed-k resampling (k=6..9) either wastes
budget on easy/obvious cases (a reliable analysis that agrees with itself
on sample 2 still pays for samples 3-6) or risks under-sampling hard cases
at low k. SPRT fixes this by testing, one sample at a time:

    H1 (reliable):   P(sample matches running leader) = p1  (high, e.g. 0.85)
    H0 (unreliable):  P(sample matches running leader) = p0  (low,  e.g. 0.35)

and accumulating a log-likelihood ratio until it crosses one of two
boundaries derived from target error rates (alpha = false-accept-H1 rate,
beta = false-accept-H0 rate). This is the same math used in industrial
quality control and clinical trial interim analysis -- applied here to
"is this analysis result trustworthy" instead of "is this batch defective."

Complements (doesn't replace) the resample_consistency primitive: same
underlying resampling operation, but the STOPPING RULE for how many
resamples to draw becomes adaptive and statistically principled instead of
a swept constant.
"""
import math
from harness import Analysis


def sprt_verdict(analysis: Analysis, rng, p0=0.35, p1=0.85, alpha=0.05, beta=0.05, k_max=15):
    """Sequentially resample `analysis`, return (verdict, disagreement,
    cost_paid, samples). verdict in {"reliable", "unreliable", "undecided"}.
    Deterministic analyses short-circuit at cost 1x (matches the
    skip_deterministic guard from the fixed-k version, but derived from the
    test itself: a deterministic stream never generates a mismatch, so LLR
    would race to the H1 boundary on sample 2 anyway -- this is just doing
    that explicitly rather than re-deriving it via simulation each time).
    """
    if analysis.is_deterministic():
        return "reliable", 0.0, analysis.cost, [analysis.sample(rng)]

    upper = math.log((1 - beta) / alpha)   # accept H1 (reliable) boundary
    lower = math.log(beta / (1 - alpha))   # accept H0 (unreliable) boundary

    samples = []
    leader = None
    llr = 0.0

    for i in range(k_max):
        s = analysis.sample(rng)
        samples.append(s)
        if leader is None:
            leader = s
            continue
        match = (s == leader)
        llr += math.log(p1 / p0) if match else math.log((1 - p1) / (1 - p0))
        if llr >= upper:
            maj = max(set(samples), key=samples.count)
            disagreement = 1 - samples.count(maj) / len(samples)
            return "reliable", disagreement, analysis.cost * len(samples), samples
        if llr <= lower:
            maj = max(set(samples), key=samples.count)
            disagreement = 1 - samples.count(maj) / len(samples)
            return "unreliable", disagreement, analysis.cost * len(samples), samples

    maj = max(set(samples), key=samples.count)
    disagreement = 1 - samples.count(maj) / len(samples)
    return "undecided", disagreement, analysis.cost * len(samples), samples


def run_sprt_policy(task, rng, p0=0.35, p1=0.85, alpha=0.05, beta=0.05, k_max=15):
    min_tries = max(1, round(0.4 * len(task.analyses)))
    total_cost = 0.0
    tries = 0
    last_answer = None
    n_resamples_used = []
    for a in task.analyses:
        tries += 1
        settled = (not a.hedge) and (not a.contradiction)
        if settled:
            verdict, disagreement, cost, samples = sprt_verdict(a, rng, p0, p1, alpha, beta, k_max)
            total_cost += cost
            n_resamples_used.append(len(samples))
            answer = max(set(samples), key=samples.count)
            trust = (verdict == "reliable")
        else:
            answer = a.sample(rng)
            total_cost += a.cost
            trust = False
        last_answer = answer
        if trust and tries >= min_tries:
            return answer, total_cost, n_resamples_used
    return last_answer, total_cost, n_resamples_used
