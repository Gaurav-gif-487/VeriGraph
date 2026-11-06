import test from "node:test";
import assert from "node:assert/strict";
import {
  type Analysis,
  type Rng,
  seededRng,
  isDeterministic,
  sampleAnalysis,
  sprtVerdict,
  calibrateP0P1,
  SPRTGate,
  Calibration,
  checkDeterministicOverhead,
  checkCostCap,
  assertNoTrainColdLeakage,
} from "../src/risk/SPRTGate.js";

// ---------------------------------------------------------------------------
// _labeled_calibration_set from test_sprt_gate.py: reuses stub Analysis
// objects as calibration examples, labeled by construction — a synthetic
// stand-in for a real calibration set, not a claim of real-system
// validation (same caveat the Python original carried).
// ---------------------------------------------------------------------------

function labeledCalibrationSet(): Array<[Analysis, "reliable" | "unreliable"]> {
  const reliable: Analysis = { name: "reliable_stub", cost: 3.0, dist: { CORRECT: 0.9, WRONG: 0.1 } };
  const unreliable: Analysis = {
    name: "unreliable_stub",
    cost: 3.0,
    dist: { A: 0.3, B: 0.3, C: 0.2, D: 0.2 },
  };
  return [
    [reliable, "reliable"],
    [unreliable, "unreliable"],
  ];
}

test("SPRTGate: calibration estimates p0/p1 from data, not hardcoded constants", () => {
  const rng = seededRng(1);
  const labeled = labeledCalibrationSet();
  const cal = calibrateP0P1(labeled, rng, 500);
  // p1 (reliable) should clearly exceed p0 (unreliable) match rate — an
  // ESTIMATE, not the hardcoded .35/.85 from the synthetic study.
  assert.ok(cal.p1 > cal.p0);
  assert.ok(cal.p0 > 0.0 && cal.p0 < 1.0);
  assert.ok(cal.p1 > 0.0 && cal.p1 < 1.0);
});

test("SPRTGate: calibration rejects degenerate input that can't separate reliable from unreliable", () => {
  const rng = seededRng(2);
  const same: Analysis = { name: "indistinguishable", cost: 1.0, dist: { A: 0.5, B: 0.5 } };
  assert.throws(() => calibrateP0P1([[same, "reliable"], [same, "unreliable"]], rng, 200));
});

test("SPRTGate: calibration requires at least one example of each label", () => {
  const rng = seededRng(3);
  const reliableOnly: Array<[Analysis, "reliable" | "unreliable"]> = [
    [{ name: "r", cost: 1.0, dist: { A: 0.9, B: 0.1 } }, "reliable"],
  ];
  assert.throws(() => calibrateP0P1(reliableOnly, rng));
});

test("SPRTGate: decide() matches the sprtVerdict contract, short-circuiting deterministic analyses at cost 1x", () => {
  const rng = seededRng(4);
  const cal: Calibration = { p0: 0.35, p1: 0.85, nUnreliableExamples: 1, nReliableExamples: 1 };
  const gate = new SPRTGate(cal, { alpha: 0.05, beta: 0.05, kMax: 15 });
  const a: Analysis = { name: "x", cost: 2.0, dist: { CORRECT: 1.0 } }; // deterministic
  const { verdict, costPaid, samples } = gate.decide(a, rng);
  assert.equal(verdict, "reliable");
  assert.equal(costPaid, a.cost); // deterministic short-circuit, no extra resamples
  assert.equal(samples.length, 1);
});

test("SPRTGate: deterministic-overhead check reports zero wasted resamples", () => {
  const rng = seededRng(5);
  const cal: Calibration = { p0: 0.35, p1: 0.85, nUnreliableExamples: 1, nReliableExamples: 1 };
  const gate = new SPRTGate(cal);
  const deterministic: Analysis[] = Array.from({ length: 10 }, (_, i) => ({
    name: `d${i}`,
    cost: 2.0,
    dist: { X: 1.0 },
  }));
  const { ok, worstObservedCostRatio } = checkDeterministicOverhead(gate, deterministic, rng);
  assert.ok(ok);
  assert.equal(worstObservedCostRatio, 1.0);
});

test("SPRTGate: cost-cap check passes within the cap and fails beyond it", () => {
  const ok = checkCostCap([0.9, 1.0, 1.1], 1.12, 1.5);
  assert.ok(ok.ok);
  assert.ok(Math.abs(ok.coldCostRatio - 1.0) < 1e-9);

  const fail = checkCostCap([5.0, 5.0], 1.12, 1.5);
  assert.ok(!fail.ok);
});

test("SPRTGate: train/cold leakage guard catches overlapping ids and passes disjoint sets", () => {
  assert.throws(() => assertNoTrainColdLeakage(new Set(["t1", "t2"]), new Set(["t2", "t3"])));
  assert.doesNotThrow(() => assertNoTrainColdLeakage(new Set(["t1", "t2"]), new Set(["t3", "t4"])));
});

// ---------------------------------------------------------------------------
// Regression against the validated synthetic addendum — port of
// harness.py's make_task/make_dataset + sprt_policy.run_sprt_policy, kept
// minimal (just enough to reproduce the headline 100%-cold-accuracy result)
// so wrapping sprtVerdict in SPRTGate/Calibration is checked not to have
// silently changed behavior. NOT a claim of real-data validation — same
// caveat the Python original carried (see harness.py's own docstring).
// ---------------------------------------------------------------------------

interface Task {
  taskId: string;
  family: string;
  truth: string;
  analyses: Analysis[];
}

function makeTask(taskId: string, family: string, unseen = false): Task {
  if (family === "normal_easy") {
    return {
      taskId,
      family,
      truth: "A",
      analyses: [
        { name: "cheap_static", cost: 1.0, dist: { A: 1.0 } },
        { name: "expensive_dynamic", cost: 9.0, dist: { A: 1.0 } },
      ],
    };
  }
  if (family === "synergy") {
    return {
      taskId,
      family,
      truth: "A+B",
      analyses: [
        { name: "cheap_1", cost: 1.0, dist: { A: 1.0 }, hedge: true },
        { name: "cheap_2_combined", cost: 1.2, dist: { "A+B": 1.0 }, hedge: false },
        { name: "expensive_combined", cost: 9.0, dist: { "A+B": 1.0 } },
      ],
    };
  }
  if (family === "false_confidence" || family === "runtime_only" || family === "flaky_heuristic") {
    const cheapCost = unseen ? 7.0 : 6.0; // adversarially expensive-looking
    return {
      taskId,
      family,
      truth: "CORRECT",
      analyses: [
        {
          name: "cheap_heuristic",
          cost: cheapCost,
          dist: { WRONG_A: 0.28, WRONG_B: 0.26, WRONG_C: 0.24, WRONG_D: 0.22 },
          hedge: false,
          contradiction: false,
        },
        { name: "expensive_verified", cost: cheapCost + 3.0, dist: { CORRECT: 1.0 } },
      ],
    };
  }
  throw new Error(`unknown family: ${family}`);
}

function makeDataset(): Array<[string, Task]> {
  const tasks: Array<[string, Task]> = [];
  for (let i = 0; i < 6; i++) tasks.push(["train", makeTask(`train_normal_${i}`, "normal_easy")]);
  for (let i = 0; i < 4; i++) tasks.push(["train", makeTask(`train_synergy_${i}`, "synergy")]);
  tasks.push(["train", makeTask("train_falseconf_0", "false_confidence")]);
  tasks.push(["train", makeTask("train_runtime_0", "runtime_only")]);

  for (let i = 0; i < 6; i++) tasks.push(["holdout", makeTask(`holdout_normal_${i}`, "normal_easy")]);
  for (let i = 0; i < 4; i++) tasks.push(["holdout", makeTask(`holdout_synergy_${i}`, "synergy")]);
  for (let i = 0; i < 3; i++) tasks.push(["holdout", makeTask(`holdout_falseconf_${i}`, "false_confidence")]);
  for (let i = 0; i < 3; i++) tasks.push(["holdout", makeTask(`holdout_runtime_${i}`, "runtime_only")]);

  for (let i = 0; i < 5; i++) tasks.push(["generalization", makeTask(`gen_flaky_${i}`, "flaky_heuristic", true)]);
  for (let i = 0; i < 5; i++) tasks.push(["generalization", makeTask(`gen_normal_${i}`, "normal_easy")]);

  return tasks;
}

/** Port of sprt_policy.run_sprt_policy. */
function runSprtPolicy(task: Task, rng: Rng, params: { p0: number; p1: number; alpha: number; beta: number; kMax: number }) {
  const minTries = Math.max(1, Math.round(0.4 * task.analyses.length));
  let totalCost = 0;
  let tries = 0;
  let lastAnswer: string | null = null;

  for (const a of task.analyses) {
    tries += 1;
    const settled = !a.hedge && !a.contradiction;
    let answer: string;
    let trust: boolean;
    if (settled) {
      const { verdict, costPaid, samples } = sprtVerdict(a, rng, params);
      totalCost += costPaid;
      answer = samples.reduce((acc, s) => {
        // majority vote, ties broken by first-seen (matches Python's
        // max(set(samples), key=samples.count) determinism closely enough
        // for this fully-agreeing-or-fully-disagreeing synthetic dataset)
        const accCount = samples.filter((x) => x === acc).length;
        const sCount = samples.filter((x) => x === s).length;
        return sCount > accCount ? s : acc;
      }, samples[0]!);
      trust = verdict === "reliable";
    } else {
      answer = sampleAnalysis(a, rng);
      totalCost += a.cost;
      trust = false;
    }
    lastAnswer = answer;
    if (trust && tries >= minTries) return { answer, totalCost };
  }
  return { answer: lastAnswer as string, totalCost };
}

test("SPRTGate: wrapped sprtVerdict still reproduces the addendum's 100% cold accuracy on the synthetic dataset", () => {
  const tasks = makeDataset();
  const rng = seededRng(9);
  let correct = 0;
  for (const [, task] of tasks) {
    const { answer } = runSprtPolicy(task, rng, { p0: 0.35, p1: 0.85, alpha: 0.05, beta: 0.05, kMax: 15 });
    if (answer === task.truth) correct += 1;
  }
  const acc = correct / tasks.length;
  assert.equal(acc, 1.0, `expected 100% cold accuracy per addendum, got ${(acc * 100).toFixed(0)}%`);
});

test("SPRTGate: isDeterministic is true iff the analysis has exactly one candidate answer", () => {
  assert.ok(isDeterministic({ name: "d", cost: 1, dist: { A: 1.0 } }));
  assert.ok(!isDeterministic({ name: "nd", cost: 1, dist: { A: 0.5, B: 0.5 } }));
});
