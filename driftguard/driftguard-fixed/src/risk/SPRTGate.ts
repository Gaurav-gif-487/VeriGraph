/**
 * Component 2: Wald's Sequential Probability Ratio Test (Wald, 1945) applied
 * to per-analysis resampling, ported from the validated Python prototype
 * (evidence-gated-phase1: sprt_policy.py + sprt/gate.py). See those files'
 * docstrings for the full derivation; this is a 1:1 behavioral port, not a
 * reimplementation — test/sprt-gate.test.ts checks the port against the
 * same fixtures/expectations the Python test suite (tests/test_sprt_gate.py)
 * used.
 *
 * H1 (reliable):   P(sample matches running leader) = p1  (high)
 * H0 (unreliable):  P(sample matches running leader) = p0  (low)
 * Sequentially resample and accumulate a log-likelihood ratio until it
 * crosses one of two boundaries derived from target error rates (alpha =
 * false-accept-H1 rate, beta = false-accept-H0 rate).
 *
 * STATUS: this module is a real, tested, standalone port — it does not by
 * itself constitute "SPRT wired into DriftGuard." Deploying it against a
 * live DriftGuard decision (see CHANGES_evidence_gated.md) requires (a) an
 * actual non-deterministic decision to resample, and (b) a REAL labeled
 * calibration set (see calibrateP0P1's docstring) — synthetic placeholders
 * for either would defeat the point of the calibration step. DriftGuard's
 * fuzzy route classifier (route-matcher.ts) was evaluated as a candidate
 * and rejected for now: `HeuristicRouteClassifier.score()` is a pure
 * deterministic function of two route templates, so there is no natural
 * "resample the same analysis again" operation to gate — resampling would
 * have to be manufactured (e.g. injected scoring jitter), which would
 * change real drift-detection output without a real calibration set behind
 * it. That remains the open item, not a missing import.
 */

// ---------------------------------------------------------------------------
// Seedable RNG — Node's Math.random() isn't seedable, and calibration/tests
// need reproducible sampling. mulberry32: small, fast, good-enough-for-this
// statistical distribution properties (not cryptographic).
// ---------------------------------------------------------------------------

export interface Rng {
  /** Returns a float in [0, 1). */
  random(): number;
}

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    random() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis model — port of harness.py's Analysis dataclass. `dist` is a
// probability distribution over candidate answers; deterministic analyses
// have exactly one answer with probability 1.
// ---------------------------------------------------------------------------

export interface Analysis {
  name: string;
  cost: number;
  dist: Record<string, number>;
  hedge?: boolean;
  contradiction?: boolean;
}

export function isDeterministic(analysis: Analysis): boolean {
  return Object.keys(analysis.dist).length === 1;
}

/** Weighted draw from analysis.dist, matching Python's
 *  `random.choices(answers, weights=weights, k=1)[0]` semantics. */
export function sampleAnalysis(analysis: Analysis, rng: Rng): string {
  const entries = Object.entries(analysis.dist);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let x = rng.random() * total;
  for (const [answer, weight] of entries) {
    x -= weight;
    if (x <= 0) return answer;
  }
  return entries[entries.length - 1]![0]; // floating-point fallback
}

function majority(samples: string[]): string {
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: string = samples[0]!;
  let bestCount = -1;
  for (const [s, c] of counts) {
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

export type SprtVerdictLabel = "reliable" | "unreliable" | "undecided";

export interface SprtVerdictResult {
  verdict: SprtVerdictLabel;
  disagreement: number;
  costPaid: number;
  samples: string[];
}

export interface SprtParams {
  p0?: number;
  p1?: number;
  alpha?: number;
  beta?: number;
  kMax?: number;
}

/**
 * Sequentially resample `analysis`, return the verdict. Deterministic
 * analyses short-circuit at cost 1x (a deterministic stream never generates
 * a mismatch, so the LLR would race to the H1 boundary on sample 2 anyway —
 * this does that explicitly rather than re-deriving it via simulation).
 */
export function sprtVerdict(analysis: Analysis, rng: Rng, params: SprtParams = {}): SprtVerdictResult {
  const { p0 = 0.35, p1 = 0.85, alpha = 0.05, beta = 0.05, kMax = 15 } = params;

  if (isDeterministic(analysis)) {
    return { verdict: "reliable", disagreement: 0.0, costPaid: analysis.cost, samples: [sampleAnalysis(analysis, rng)] };
  }

  const upper = Math.log((1 - beta) / alpha); // accept H1 (reliable) boundary
  const lower = Math.log(beta / (1 - alpha)); // accept H0 (unreliable) boundary

  const samples: string[] = [];
  let leader: string | null = null;
  let llr = 0.0;

  const disagreementOf = (s: string[]) => {
    const maj = majority(s);
    const majCount = s.filter((x) => x === maj).length;
    return 1 - majCount / s.length;
  };

  for (let i = 0; i < kMax; i++) {
    const s = sampleAnalysis(analysis, rng);
    samples.push(s);
    if (leader === null) {
      leader = s;
      continue;
    }
    const match = s === leader;
    llr += match ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
    if (llr >= upper) {
      return { verdict: "reliable", disagreement: disagreementOf(samples), costPaid: analysis.cost * samples.length, samples };
    }
    if (llr <= lower) {
      return { verdict: "unreliable", disagreement: disagreementOf(samples), costPaid: analysis.cost * samples.length, samples };
    }
  }

  return { verdict: "undecided", disagreement: disagreementOf(samples), costPaid: analysis.cost * samples.length, samples };
}

// ---------------------------------------------------------------------------
// Calibration + deployment wrapper — port of sprt/gate.py.
// ---------------------------------------------------------------------------

export interface Calibration {
  p0: number; // est. P(two samples match | analysis is genuinely unreliable)
  p1: number; // est. P(two samples match | analysis is genuinely reliable)
  nUnreliableExamples: number;
  nReliableExamples: number;
}

export type CalibrationLabel = "reliable" | "unreliable";

/**
 * Estimate p0/p1 from a REAL calibration set — not carried over from
 * synthetic design values. `labeledExamples` must be [analysis, label]
 * pairs where the label is determined externally (e.g. against ground
 * truth on a calibration slice), NOT by the SPRT test itself, or the
 * estimate would be circular.
 *
 * For each example, draws nPairsPerExample independent same-analysis
 * sample pairs and measures the empirical match rate; p0/p1 are the
 * match-rate averages within each label group.
 */
export function calibrateP0P1(
  labeledExamples: Array<[Analysis, CalibrationLabel]>,
  rng: Rng,
  nPairsPerExample = 20,
): Calibration {
  let reliableMatches = 0;
  let reliableTotal = 0;
  let unreliableMatches = 0;
  let unreliableTotal = 0;

  for (const [analysis, label] of labeledExamples) {
    if (isDeterministic(analysis)) continue; // carries no information about p0/p1
    for (let i = 0; i < nPairsPerExample; i++) {
      const a = sampleAnalysis(analysis, rng);
      const b = sampleAnalysis(analysis, rng);
      const match = a === b ? 1 : 0;
      if (label === "reliable") {
        reliableMatches += match;
        reliableTotal += 1;
      } else if (label === "unreliable") {
        unreliableMatches += match;
        unreliableTotal += 1;
      } else {
        throw new Error(`label must be 'reliable' or 'unreliable', got ${String(label)}`);
      }
    }
  }

  if (reliableTotal === 0 || unreliableTotal === 0) {
    throw new Error(
      "calibration set must contain at least one non-deterministic example of EACH label " +
        `('reliable' and 'unreliable') — got ${reliableTotal} reliable-label samples, ` +
        `${unreliableTotal} unreliable-label samples`,
    );
  }

  const p1 = reliableMatches / reliableTotal;
  const p0 = unreliableMatches / unreliableTotal;

  // Guard against a degenerate/inverted calibration: if the estimated gap
  // is non-positive, the SPRT math (log(p1/p0), log((1-p1)/(1-p0))) breaks
  // down or points the wrong way — fail loudly rather than silently deploy
  // a miscalibrated gate.
  if (!(0.0 < p0 && p0 < p1 && p1 < 1.0)) {
    throw new Error(
      `calibration produced p0=${p0.toFixed(3)}, p1=${p1.toFixed(3)} — need 0 < p0 < p1 < 1 for the ` +
        "SPRT boundaries to be meaningful. This usually means the labeled calibration set doesn't " +
        "actually separate reliable from unreliable examples; check the labels before deploying, " +
        "don't just widen the pairs count.",
    );
  }

  return {
    p0,
    p1,
    nUnreliableExamples: labeledExamples.filter(([, l]) => l === "unreliable").length,
    nReliableExamples: labeledExamples.filter(([, l]) => l === "reliable").length,
  };
}

/**
 * Single-deployment gate: wraps the validated sprtVerdict for exactly one
 * real analysis site. Not a shared primitive — construct a new SPRTGate per
 * deployment if a second one is ever validated, don't reuse this instance's
 * calibration elsewhere.
 */
export class SPRTGate {
  readonly calibration: Calibration;
  readonly alpha: number;
  readonly beta: number;
  readonly kMax: number;

  constructor(calibration: Calibration, options: { alpha?: number; beta?: number; kMax?: number } = {}) {
    this.calibration = calibration;
    this.alpha = options.alpha ?? 0.05;
    this.beta = options.beta ?? 0.05;
    this.kMax = options.kMax ?? 15;
  }

  /** Identical contract to sprtVerdict, using this gate's calibrated p0/p1
   *  rather than hardcoded constants. */
  decide(analysis: Analysis, rng: Rng): SprtVerdictResult {
    return sprtVerdict(analysis, rng, {
      p0: this.calibration.p0,
      p1: this.calibration.p1,
      alpha: this.alpha,
      beta: this.beta,
      kMax: this.kMax,
    });
  }
}

// ---------------------------------------------------------------------------
// Negative-result checks — port of gate.py's discipline checks: re-run per
// the original design doc's own discipline (train-only fit, cold-only
// eval), structurally, not just repeated on the same data under a
// different name.
// ---------------------------------------------------------------------------

/** Deterministic analyses must short-circuit at cost 1x — no wasted
 *  resamples. Returns { ok, worstObservedCostRatio }. */
export function checkDeterministicOverhead(
  gate: SPRTGate,
  deterministicAnalyses: Analysis[],
  rng: Rng,
): { ok: boolean; worstObservedCostRatio: number } {
  let worst = 0.0;
  for (const a of deterministicAnalyses) {
    const { costPaid } = gate.decide(a, rng);
    const ratio = costPaid / a.cost;
    worst = Math.max(worst, ratio);
    if (ratio > 1.0 + 1e-9) return { ok: false, worstObservedCostRatio: worst };
  }
  return { ok: true, worstObservedCostRatio: worst };
}

/** Cold cost must not exceed `capMultiplier` x baseline. Returns
 *  { ok, coldCostRatio }. */
export function checkCostCap(
  coldTasksCosts: number[],
  baselineCostRatio: number,
  capMultiplier = 1.5,
): { ok: boolean; coldCostRatio: number } {
  if (coldTasksCosts.length === 0) return { ok: false, coldCostRatio: NaN };
  const coldRatio = coldTasksCosts.reduce((a, b) => a + b, 0) / coldTasksCosts.length;
  return { ok: coldRatio <= baselineCostRatio * capMultiplier, coldCostRatio: coldRatio };
}

/** Structural guard: throw, at call time, if the same task/example ID
 *  appears in both the calibration (train) set and the cold evaluation set
 *  — "no tuning against cold results" enforced as code, not as a promise. */
export function assertNoTrainColdLeakage(trainIds: Set<string>, coldIds: Set<string>): void {
  const overlap = [...trainIds].filter((id) => coldIds.has(id));
  if (overlap.length > 0) {
    throw new Error(
      `train/cold leakage detected: ${overlap.length} id(s) appear in both sets ` +
        `(${overlap.slice().sort().slice(0, 5).join(", ")}...) — calibration must be fit on train ` +
        "only and evaluated cold on disjoint data.",
    );
  }
}
