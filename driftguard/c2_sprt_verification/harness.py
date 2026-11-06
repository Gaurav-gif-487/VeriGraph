"""
Prototype: resample-consistency as a per-analysis reliability signal for
adaptive evidence-acquisition stopping.

This is a from-scratch synthetic re-implementation of the experiment proposed
in SYNTHESIS_and_proposal.md. I don't have the four source repos, so this
harness rebuilds the relevant slice: a benchmark task schema with cost-ordered
analyses, a stop-rule policy that can use {cost, hedge, contradictions, tries}
and/or a new {resample_consistency} feature, and the train/holdout/stress/
generalization evaluation discipline the doc describes.

Goal: actually test the claim, not just assert it. Everything below is
measured, not asserted.
"""
import random
import statistics as stats
from dataclasses import dataclass, field
from typing import Callable, Optional


# ---------------------------------------------------------------------------
# 1. Analysis model
# ---------------------------------------------------------------------------
# Every analysis, when run once, returns (answer, hedge, contradiction_flag).
# Non-deterministic analyses additionally expose an underlying answer
# *distribution* that resampling can reveal. Deterministic analyses always
# return the same answer -> resampling produces zero disagreement, i.e. the
# feature degenerates to "no information," exactly as the proposal predicts.

@dataclass
class Analysis:
    name: str
    cost: float
    # underlying distribution over candidate answers: {answer: probability}
    # deterministic analyses have a single answer with probability 1.0
    dist: dict
    hedge: bool = False
    contradiction: bool = False

    def sample(self, rng: random.Random):
        answers = list(self.dist.keys())
        weights = list(self.dist.values())
        return rng.choices(answers, weights=weights, k=1)[0]

    def is_deterministic(self):
        return len(self.dist) == 1


@dataclass
class Task:
    task_id: str
    family: str
    truth: str
    analyses: list  # cost-ascending list[Analysis]


# ---------------------------------------------------------------------------
# 2. The resample-consistency primitive
#    (ported 1:1 from the clusterPlans / computeVPD description: resample N
#    times, cluster identical answers together, score disagreement as
#    1 - largest_cluster / N)
# ---------------------------------------------------------------------------

def resample_consistency(analysis: Analysis, k: int, rng: random.Random):
    """Returns (disagreement_score, cost_of_resampling, samples)."""
    if analysis.is_deterministic():
        # No epistemic content to expose. One call suffices; the proposal's
        # own scoping ("degenerates to nothing on deterministic analyses")
        # predicts this, so the policy should special-case it -- but we also
        # test what happens when it DOESN'T (see policy variants below).
        return 0.0, analysis.cost, [analysis.sample(rng)]
    samples = [analysis.sample(rng) for _ in range(k)]
    largest_cluster = max(samples.count(a) for a in set(samples))
    disagreement = 1 - largest_cluster / len(samples)
    return disagreement, analysis.cost * k, samples


# ---------------------------------------------------------------------------
# 3. Task families
# ---------------------------------------------------------------------------
# "normal_easy": cheap analysis is correct and stable. Adaptive should stop
#   after analysis 1 regardless of policy.
# "false_confidence": cheap analysis is WRONG, confident (no hedge, no
#   contradiction flag), and -- the adversarial part that broke the old
#   feature set -- has the HIGHEST cost-ratio in its cluster, so any
#   cost-trusts-more heuristic is forced to get it wrong. Underneath,
#   though, the cheap analysis is a flaky heuristic: resampling it exposes
#   answer instability that the surface features (hedge/contradiction) never
#   see. The expensive analysis is correct and stable under resample.
# "runtime_only": same adversarial shape, different surface family label
#   (mirrors the doc's T008/T015 split), used to check within-mechanism
#   generalization across two named families.
# "synergy": needs two cheap analyses combined; included for completeness /
#   to confirm the new signal doesn't regress the mechanism the doc already
#   shipped (min_tries floor) -- resample-consistency is silent here because
#   both analyses are deterministic and individually "correct-looking."

def make_task(task_id, family, rng: random.Random, unseen=False):
    if family == "normal_easy":
        truth = "A"
        cheap = Analysis("cheap_static", cost=1.0, dist={"A": 1.0})
        expensive = Analysis("expensive_dynamic", cost=9.0, dist={"A": 1.0})
        return Task(task_id, family, truth, [cheap, expensive])

    if family == "synergy":
        # Mirrors the doc's actual synergy failure mode: the first cheap
        # analysis LOOKS settled (unhedged) but is individually insufficient
        # -- truth needs both. Modeled here by marking analysis 1 as
        # explicitly not-yet-conclusive (hedge=True) so the existing
        # min_tries-floor mechanism (already shipped per the doc, not the
        # thing under test here) is what carries a task past it, and
        # analysis 2 already encodes the combined, settled answer. This
        # keeps synergy's job narrow: confirm the NEW mechanism doesn't
        # regress the OLD mechanism's fix, not re-derive the old fix.
        truth = "A+B"
        a1 = Analysis("cheap_1", cost=1.0, dist={"A": 1.0}, hedge=True)
        a2 = Analysis("cheap_2_combined", cost=1.2, dist={"A+B": 1.0}, hedge=False)
        expensive = Analysis("expensive_combined", cost=9.0, dist={"A+B": 1.0})
        return Task(task_id, family, truth, [a1, a2, expensive])

    if family in ("false_confidence", "runtime_only", "flaky_heuristic"):
        truth = "CORRECT"
        # Cheap analysis: confidently wrong, but internally a near-uniform
        # heuristic over several plausible wrong answers -- resampling
        # reveals high disagreement instead of a stable wrong answer.
        # cost-ratio deliberately HIGHEST in its local cluster (mirrors
        # T008's domination-proof property: cost cannot be the tell).
        cheap_cost = 6.0 if not unseen else 7.0  # adversarially expensive-looking
        cheap = Analysis(
            "cheap_heuristic",
            cost=cheap_cost,
            dist={"WRONG_A": 0.28, "WRONG_B": 0.26, "WRONG_C": 0.24, "WRONG_D": 0.22},
            hedge=False,
            contradiction=False,
        )
        expensive = Analysis(
            "expensive_verified",
            cost=cheap_cost + 3.0,
            dist={"CORRECT": 1.0},
        )
        return Task(task_id, family, truth, [cheap, expensive])

    raise ValueError(family)


def make_dataset(seed):
    rng = random.Random(seed)
    tasks = []
    # train: used to fit thresholds
    for i in range(6):
        tasks.append(("train", make_task(f"train_normal_{i}", "normal_easy", rng)))
    for i in range(4):
        tasks.append(("train", make_task(f"train_synergy_{i}", "synergy", rng)))
    tasks.append(("train", make_task("train_falseconf_0", "false_confidence", rng)))
    tasks.append(("train", make_task("train_runtime_0", "runtime_only", rng)))

    # holdout: same families, fresh instances, never touched while fitting
    for i in range(6):
        tasks.append(("holdout", make_task(f"holdout_normal_{i}", "normal_easy", rng)))
    for i in range(4):
        tasks.append(("holdout", make_task(f"holdout_synergy_{i}", "synergy", rng)))
    for i in range(3):
        tasks.append(("holdout", make_task(f"holdout_falseconf_{i}", "false_confidence", rng)))
    for i in range(3):
        tasks.append(("holdout", make_task(f"holdout_runtime_{i}", "runtime_only", rng)))

    # generalization: unseen family, never named while fitting
    for i in range(5):
        tasks.append(("generalization", make_task(f"gen_flaky_{i}", "flaky_heuristic", rng, unseen=True)))
    for i in range(5):
        tasks.append(("generalization", make_task(f"gen_normal_{i}", "normal_easy", rng)))

    return tasks
