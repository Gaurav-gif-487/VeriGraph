// VeriGraph: TypeScript pooled discrete-time hazard model.
// Real Newton-Raphson / IRLS logistic regression -- no hardcoded
// coefficients. Mirrors python/verigraph.py's fit_logistic exactly so both
// engines produce the same numbers on the same data.

import { StockFlowEngine, ALARM_THRESHOLD } from './stockFlowEngine';

export const DIFFICULTY_MAP: Record<string, number> = { easy: 0.0, medium: 1.0, hard: 2.0 };
export const FEATURE_ORDER = [
  'stock',
  'flow',
  'stock_x_flow',
  'delta_stock_existing',
  'new_node_stock',
  'step_frac',
  'nodes_seen',
  'task_difficulty',
] as const;
export type FeatureName = (typeof FEATURE_ORDER)[number];

export interface FeatureRow extends Record<FeatureName, number> {}

export interface PersonPeriodExtraction {
  rows: FeatureRow[];
  labels: number[];
  traceIds: string[];
  traceStepIndex: number[];
  perTraceSnaps: Record<string, ReturnType<StockFlowEngine['analyzeTrace']>>;
}

// ---------------------------------------------------------------------------
// Minimal linear algebra (mirrors the Python stdlib-only implementation)
// ---------------------------------------------------------------------------
function matZeros(r: number, c: number): number[][] {
  return Array.from({ length: r }, () => new Array(c).fill(0));
}

function matInverse(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-12) M[pivotRow][col] += 1e-9;
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    const piv = M[col][col];
    M[col] = M[col].map((x) => x / piv);
    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const factor = M[r][col];
        if (factor !== 0) {
          M[r] = M[r].map((x, j) => x - factor * M[col][j]);
        }
      }
    }
  }
  return M.map((row) => row.slice(n));
}

function normCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.sqrt(2)));
}

// Abramowitz & Stegun 7.1.26 approximation (max error ~1.5e-7)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function standardize(
  X: number[][],
  excludeIdx: Set<number> = new Set([0])
): { Xs: number[][]; means: number[]; stds: number[] } {
  const n = X.length;
  const k = X[0].length;
  const means = new Array(k).fill(0);
  const stds = new Array(k).fill(1);
  for (let j = 0; j < k; j++) {
    if (excludeIdx.has(j)) continue;
    const col = X.map((row) => row[j]);
    const m = col.reduce((a, b) => a + b, 0) / n;
    const varr = col.reduce((a, c) => a + (c - m) ** 2, 0) / n;
    const s = varr > 1e-9 ? Math.sqrt(varr) : 1.0;
    means[j] = m;
    stds[j] = s;
  }
  const Xs = X.map((row) => row.map((v, j) => (excludeIdx.has(j) ? v : (v - means[j]) / stds[j])));
  return { Xs, means, stds };
}

// ---------------------------------------------------------------------------
// Logistic regression via Newton-Raphson / IRLS with an L2 ridge penalty.
// ridge=1.0: with only ~25 independent traces behind up to 224
// pseudo-replicated person-period rows and up to 9 parameters, an
// unregularized fit hits quasi-complete separation (coefficients diverge,
// pseudo-R^2 saturates at 1.0). The penalty keeps the fit identifiable.
// ---------------------------------------------------------------------------
export class LogisticFitResult {
  constructor(
    public names: string[],
    public beta: number[],
    public se: number[],
    public logLikelihood: number,
    public aic: number,
    public pseudoR2: number
  ) {}

  zScores(): number[] {
    return this.beta.map((b, i) => (this.se[i] > 1e-9 ? b / this.se[i] : 0));
  }

  pValues(): number[] {
    return this.zScores().map((z) => 2 * (1 - normCdf(Math.abs(z))));
  }

  oddsRatios(): number[] {
    return this.beta.map((b) => Math.exp(b));
  }
}

export function fitLogistic(
  X: number[][],
  y: number[],
  names: string[],
  ridge = 1.0,
  maxIter = 50,
  tol = 1e-8
): LogisticFitResult {
  const n = X.length;
  const k = X[0].length;
  let beta = new Array(k).fill(0);
  let ll: number | null = null;

  const computeEtaP = (b: number[]) => {
    const eta = X.map((row) => row.reduce((s, x, j) => s + x * b[j], 0));
    const p = eta.map((e) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, e)))));
    return { eta, p };
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const { p } = computeEtaP(beta);
    const w = p.map((pi) => Math.max(pi * (1 - pi), 1e-6));
    const grad = new Array(k).fill(0);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j] * (y[i] - p[i]);
      grad[j] = s;
    }
    const XtWX = matZeros(k, k);
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      const Xi = X[i];
      for (let a = 0; a < k; a++) {
        const xa = Xi[a] * wi;
        if (xa === 0) continue;
        for (let b = 0; b < k; b++) XtWX[a][b] += xa * Xi[b];
      }
    }
    for (let a = 0; a < k; a++) XtWX[a][a] += ridge;
    const infoInv = matInverse(XtWX);
    const step = new Array(k).fill(0);
    for (let a = 0; a < k; a++) {
      let s = 0;
      for (let b = 0; b < k; b++) s += infoInv[a][b] * grad[b];
      step[a] = s;
    }
    beta = beta.map((b, j) => b + step[j]);
    const newLl = y.reduce(
      (acc, yi, i) => acc + (yi * Math.log(Math.max(p[i], 1e-12)) + (1 - yi) * Math.log(Math.max(1 - p[i], 1e-12))),
      0
    );
    if (ll !== null && Math.abs(newLl - ll) < tol) {
      ll = newLl;
      break;
    }
    ll = newLl;
  }

  const { p } = computeEtaP(beta);
  const w = p.map((pi) => Math.max(pi * (1 - pi), 1e-6));
  const XtWX = matZeros(k, k);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    const Xi = X[i];
    for (let a = 0; a < k; a++) {
      const xa = Xi[a] * wi;
      if (xa === 0) continue;
      for (let b = 0; b < k; b++) XtWX[a][b] += xa * Xi[b];
    }
  }
  for (let a = 0; a < k; a++) XtWX[a][a] += ridge;
  const infoInv = matInverse(XtWX);
  const se = infoInv.map((row, j) => Math.sqrt(Math.max(row[j], 0)));

  const aic = 2 * k - 2 * (ll ?? 0);
  const ybar = Math.min(Math.max(y.reduce((a, b) => a + b, 0) / n, 1e-9), 1 - 1e-9);
  const llNull = y.reduce((acc, yi) => acc + (yi * Math.log(ybar) + (1 - yi) * Math.log(1 - ybar)), 0);
  const pseudoR2 = llNull !== 0 ? 1 - (ll ?? 0) / llNull : 0;

  return new LogisticFitResult(names, beta, se, ll ?? 0, aic, pseudoR2);
}

// ---------------------------------------------------------------------------
// Person-period extraction (pooled discrete-time hazard rows)
// ---------------------------------------------------------------------------
export interface RawTrace {
  id: string;
  name?: string;
  ground_truth?: string;
  task_difficulty?: string;
  events?: import('./stockFlowEngine').TraceEvent[];
}

export function extractPersonPeriodRows(traces: RawTrace[]): PersonPeriodExtraction {
  const engine = new StockFlowEngine();
  const rows: FeatureRow[] = [];
  const labels: number[] = [];
  const traceIds: string[] = [];
  const traceStepIndex: number[] = [];
  const perTraceSnaps: Record<string, ReturnType<StockFlowEngine['analyzeTrace']>> = {};

  for (const tr of traces) {
    const analyzed = engine.analyzeTrace(tr);
    perTraceSnaps[tr.id] = analyzed;
    const nSteps = analyzed.snapshots.length;
    const bad = tr.ground_truth !== 'benign_success';
    const diff = DIFFICULTY_MAP[tr.task_difficulty ?? 'medium'] ?? 1.0;

    analyzed.snapshots.forEach((s, i) => {
      rows.push({
        stock: s.stock_t,
        flow: s.flow_t,
        stock_x_flow: s.stock_times_flow,
        delta_stock_existing: s.delta_stock_existing_t,
        new_node_stock: s.new_node_stock_t,
        step_frac: (i + 1) / nSteps,
        nodes_seen: s.node_count,
        task_difficulty: diff,
      });
      labels.push(bad && i === nSteps - 1 ? 1 : 0); // outcome only observable at trace end
      traceIds.push(tr.id);
      traceStepIndex.push(i);
    });
  }

  return { rows, labels, traceIds, traceStepIndex, perTraceSnaps };
}

export function buildMatrix(rows: FeatureRow[], featureNames: readonly string[]): { X: number[][]; names: string[] } {
  const X = rows.map((r) => [1.0, ...featureNames.map((f) => r[f as FeatureName])]);
  return { X, names: ['intercept', ...featureNames] };
}

export interface FitAndScoreResult {
  fit: LogisticFitResult;
  probs: number[];
  means: number[];
  stds: number[];
}

export function fitAndScore(featureNames: readonly string[], rows: FeatureRow[], labels: number[]): FitAndScoreResult {
  const { X: Xraw, names } = buildMatrix(rows, featureNames);
  const { Xs, means, stds } = standardize(Xraw, new Set([0]));
  const fit = fitLogistic(Xs, labels, names);
  const eta = Xs.map((row) => row.reduce((s, x, j) => s + x * fit.beta[j], 0));
  const probs = eta.map((e) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, e)))));
  return { fit, probs, means, stds };
}

/** Namespaced facade kept for parity with the original CLI's import shape. */
export const PooledLogisticModel = {
  extractPersonPeriodRows,
  fitLogistic,
  fitAndScore,
  buildMatrix,
  standardize,
  ALARM_THRESHOLD,
};
