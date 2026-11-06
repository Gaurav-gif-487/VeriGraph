import random
from harness import resample_consistency


def exhaustive_cost(task):
    return sum(a.cost for a in task.analyses)


def run_baseline_policy(task, rng):
    """Old feature set only: cost, hedge, contradiction, tries-so-far.
    Decision rule: stop at first unhedged, uncontradicted result UNLESS
    tries-so-far < min_tries floor (the shipped Mechanism B from the doc,
    included so this baseline is the *actual* best prior mechanism, not a
    strawman). This is expected to fail false_confidence/runtime_only by
    construction -- confirming the domination proof before testing the fix.
    """
    min_tries = max(1, round(0.4 * len(task.analyses)))
    total_cost = 0.0
    tries = 0
    for a in task.analyses:
        answer = a.sample(rng)
        total_cost += a.cost
        tries += 1
        settled = (not a.hedge) and (not a.contradiction)
        if settled and tries >= min_tries:
            return answer, total_cost
    return answer, total_cost  # fell through: exhausted


def run_resample_policy(task, rng, disagreement_threshold, k=9, skip_deterministic=True):
    """New feature set: baseline logic, but a settled-looking result is only
    trusted if its resample-consistency disagreement is below threshold.
    skip_deterministic=True encodes the proposal's own scoping (don't bother
    resampling analyses with no epistemic content); =False is included to
    honestly measure the cost of NOT special-casing that, per the doc's
    negative-result-checks discipline.
    """
    min_tries = max(1, round(0.4 * len(task.analyses)))
    total_cost = 0.0
    tries = 0
    last_answer = None
    for a in task.analyses:
        tries += 1
        settled = (not a.hedge) and (not a.contradiction)

        if settled and (not skip_deterministic or not a.is_deterministic()):
            disagreement, resample_cost, samples = resample_consistency(a, k, rng)
            total_cost += resample_cost
            # majority answer among resamples, not just one draw
            answer = max(set(samples), key=samples.count)
            trust = disagreement <= disagreement_threshold
        else:
            answer = a.sample(rng)
            total_cost += a.cost
            disagreement = 0.0
            trust = settled

        last_answer = answer
        if trust and tries >= min_tries:
            return answer, total_cost
    return last_answer, total_cost


def evaluate(tasks, policy_fn, seed):
    rng = random.Random(seed)
    rows = []
    for split, task in tasks:
        answer, cost = policy_fn(task, rng)
        correct = (answer == task.truth)
        exh = exhaustive_cost(task)
        rows.append({
            "split": split,
            "family": task.family,
            "task_id": task.task_id,
            "correct": correct,
            "cost": cost,
            "exhaustive_cost": exh,
            "cost_ratio": cost / exh,
        })
    return rows


def summarize(rows, label):
    from collections import defaultdict
    by_split = defaultdict(list)
    for r in rows:
        by_split[r["split"]].append(r)
    print(f"\n=== {label} ===")
    for split, rs in by_split.items():
        acc = sum(r["correct"] for r in rs) / len(rs)
        avg_cost_ratio = sum(r["cost_ratio"] for r in rs) / len(rs)
        print(f"  [{split:14s}] n={len(rs):3d}  accuracy={acc:.2f}  avg_cost_ratio={avg_cost_ratio:.2f}")
    # per-family breakdown for the adversarial families specifically
    print("  -- adversarial families --")
    by_fam = defaultdict(list)
    for r in rows:
        if r["family"] in ("false_confidence", "runtime_only", "flaky_heuristic"):
            by_fam[(r["split"], r["family"])].append(r)
    for (split, fam), rs in sorted(by_fam.items()):
        acc = sum(r["correct"] for r in rs) / len(rs)
        avg_cost_ratio = sum(r["cost_ratio"] for r in rs) / len(rs)
        print(f"    {split:14s} {fam:18s} n={len(rs):2d}  accuracy={acc:.2f}  avg_cost_ratio={avg_cost_ratio:.2f}")
    return by_split
