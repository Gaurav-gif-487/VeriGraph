import random
import statistics
from harness import make_dataset, resample_consistency
from policies import run_resample_policy, run_baseline_policy, evaluate as evaluate_fixed
from sprt_policy import run_sprt_policy, sprt_verdict

SEED = 20260822
tasks = make_dataset(SEED)
train_tasks = [(s, t) for s, t in tasks if s == "train"]
cold_tasks = [(s, t) for s, t in tasks if s != "train"]


def evaluate_sprt(tasks, seed, **kwargs):
    rng = random.Random(seed)
    rows = []
    all_resample_counts = []
    for split, task in tasks:
        answer, cost, resample_counts = run_sprt_policy(task, rng, **kwargs)
        all_resample_counts.extend(resample_counts)
        exh = sum(a.cost for a in task.analyses)
        rows.append({
            "split": split, "family": task.family, "task_id": task.task_id,
            "correct": answer == task.truth, "cost": cost,
            "exhaustive_cost": exh, "cost_ratio": cost / exh,
        })
    return rows, all_resample_counts


print("=" * 70)
print("PART A: SPRT policy vs best fixed-k policy (k=6, thr=0.30) from last round")
print("=" * 70)

rows_fixed = evaluate_fixed(tasks, lambda t, r: run_resample_policy(t, r, disagreement_threshold=0.30, k=6), seed=8)
acc_fixed = sum(r["correct"] for r in rows_fixed) / len(rows_fixed)
cost_fixed = sum(r["cost_ratio"] for r in rows_fixed) / len(rows_fixed)
adv_fixed = [r for r in rows_fixed if r["family"] in ("false_confidence", "runtime_only", "flaky_heuristic")]
acc_fixed_adv = sum(r["correct"] for r in adv_fixed) / len(adv_fixed)
cost_fixed_adv = sum(r["cost_ratio"] for r in adv_fixed) / len(adv_fixed)

rows_sprt, resample_counts = evaluate_sprt(tasks, seed=9, p0=0.35, p1=0.85, alpha=0.05, beta=0.05, k_max=15)
acc_sprt = sum(r["correct"] for r in rows_sprt) / len(rows_sprt)
cost_sprt = sum(r["cost_ratio"] for r in rows_sprt) / len(rows_sprt)
adv_sprt = [r for r in rows_sprt if r["family"] in ("false_confidence", "runtime_only", "flaky_heuristic")]
acc_sprt_adv = sum(r["correct"] for r in adv_sprt) / len(adv_sprt)
cost_sprt_adv = sum(r["cost_ratio"] for r in adv_sprt) / len(adv_sprt)

print(f"\n{'policy':30s} {'acc(all)':>9} {'cost_ratio(all)':>16} {'acc(adv)':>9} {'cost_ratio(adv)':>16}")
print(f"{'fixed k=6, thr=0.30':30s} {acc_fixed:>9.2f} {cost_fixed:>16.2f} {acc_fixed_adv:>9.2f} {cost_fixed_adv:>16.2f}")
print(f"{'SPRT (p0=.35,p1=.85,a=b=.05)':30s} {acc_sprt:>9.2f} {cost_sprt:>16.2f} {acc_sprt_adv:>9.2f} {cost_sprt_adv:>16.2f}")

print(f"\nAverage resamples actually drawn per non-deterministic analysis (SPRT): "
      f"{statistics.mean(resample_counts):.2f}  (fixed policy always drew exactly 6)")
print(f"Distribution of resample counts drawn: min={min(resample_counts)}, "
      f"median={statistics.median(resample_counts)}, max={max(resample_counts)}")

print("\n" + "=" * 70)
print("PART B: does the alpha/beta error-rate guarantee actually hold?")
print("(This is the thing fixed-k thresholds never gave us: a testable")
print(" theoretical claim, not just an empirically-swept number.)")
print("=" * 70)

# Simulate the SPRT test in isolation, many times, on streams generated at
# EXACTLY p0 and EXACTLY p1, to check the empirical error rate matches the
# design alpha/beta -- this validates the statistical machinery itself,
# independent of the task harness.
import random as _random

def simulate_stream_llr(p_match, n_trials, p0, p1, alpha, beta, k_max, seed):
    rng = _random.Random(seed)
    upper = __import__("math").log((1 - beta) / alpha)
    lower = __import__("math").log(beta / (1 - alpha))
    verdicts = {"reliable": 0, "unreliable": 0, "undecided": 0}
    for _ in range(n_trials):
        llr = 0.0
        decided = False
        for i in range(k_max - 1):  # first sample establishes leader, no test
            match = rng.random() < p_match
            llr += __import__("math").log(p1 / p0) if match else __import__("math").log((1 - p1) / (1 - p0))
            if llr >= upper:
                verdicts["reliable"] += 1
                decided = True
                break
            if llr <= lower:
                verdicts["unreliable"] += 1
                decided = True
                break
        if not decided:
            verdicts["undecided"] += 1
    return verdicts

n_trials = 5000
p0, p1, alpha, beta, k_max = 0.35, 0.85, 0.05, 0.05, 15

print(f"\nStream truly generated at p_match=p0={p0} (should-be-UNRELIABLE ground truth):")
v = simulate_stream_llr(p0, n_trials, p0, p1, alpha, beta, k_max, seed=101)
false_accept_rate = v["reliable"] / n_trials
print(f"  verdicts over {n_trials} trials: {v}")
print(f"  false 'reliable' rate = {false_accept_rate:.3f}  (design target: alpha={alpha})")

print(f"\nStream truly generated at p_match=p1={p1} (should-be-RELIABLE ground truth):")
v = simulate_stream_llr(p1, n_trials, p0, p1, alpha, beta, k_max, seed=102)
false_reject_rate = v["unreliable"] / n_trials
print(f"  verdicts over {n_trials} trials: {v}")
print(f"  false 'unreliable' rate = {false_reject_rate:.3f}  (design target: beta={beta})")

print("\n(If these come in near 0.05, the SPRT machinery is doing exactly what")
print(" the theory promises -- a genuinely new capability vs. the swept")
print(" threshold, which had no such guarantee and no way to give one.)")

print("\n" + "=" * 70)
print("PART C: does dialing alpha/beta give a PREDICTABLE cost/accuracy knob?")
print("(this is the capability a swept threshold can't offer: theory tells")
print(" you which direction and roughly how much before you run anything)")
print("=" * 70)
print(f"\n{'alpha=beta':>10} {'cold_acc':>9} {'cold_cost_ratio':>16} {'median_resamples':>17}")
for ab in [0.2, 0.1, 0.05, 0.02, 0.01]:
    rows, counts = evaluate_sprt(cold_tasks, seed=55, p0=0.35, p1=0.85, alpha=ab, beta=ab, k_max=25)
    acc = sum(r["correct"] for r in rows) / len(rows)
    cost = sum(r["cost_ratio"] for r in rows) / len(rows)
    med = statistics.median(counts) if counts else float("nan")
    print(f"{ab:>10.2f} {acc:>9.2f} {cost:>16.2f} {med:>17.1f}")
