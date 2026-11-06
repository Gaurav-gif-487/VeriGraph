// VeriGraph: TypeScript evaluation harness.
// AUROC (tie-aware Mann-Whitney rank-sum), F1 at the alarm threshold, Brier
// score, and the ablation matrix comparing feature-set variants. All numbers
// are computed from the fitted model's predictions -- nothing here is
// hardcoded.

import { ALARM_THRESHOLD } from './stockFlowEngine';
import {
  FEATURE_ORDER,
  RawTrace,
  extractPersonPeriodRows,
  fitAndScore,
  FeatureName,
  LogisticFitResult,
} from './logisticModel';

export interface ModelEvalResult {
  model_name: string;
  feature_names: readonly string[];
  auroc: number;
  f1_score: number;
  brier_score: number;
  lead_time_gain_steps: number;
  fit: LogisticFitResult;
}

export function auroc(scores: number[], labels: number[]): number {
  const posN = labels.reduce((a, b) => a + b, 0);
  const negN = labels.length - posN;
  if (posN === 0 || negN === 0) return NaN;

  const order = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(scores.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && scores[order[j + 1]] === scores[order[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let m = i; m <= j; m++) ranks[order[m]] = avgRank;
    i = j + 1;
  }
  const rankSumPos = labels.reduce((acc, l, idx) => acc + (l === 1 ? ranks[idx] : 0), 0);
  const u = rankSumPos - (posN * (posN + 1)) / 2;
  return u / (posN * negN);
}

export function f1AtAlarm(alarmFlags: boolean[], labels: number[]): number {
  let tp = 0,
    fp = 0,
    fn = 0;
  alarmFlags.forEach((a, i) => {
    const l = labels[i];
    if (a && l) tp++;
    else if (a && !l) fp++;
    else if (!a && l) fn++;
  });
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
}

export function brierScore(probs: number[], labels: number[]): number {
  const n = probs.length;
  if (n === 0) return NaN;
  return probs.reduce((acc, p, i) => acc + (p - labels[i]) ** 2, 0) / n;
}

export function evaluateModel(
  modelName: string,
  featureNames: readonly FeatureName[],
  rows: ReturnType<typeof extractPersonPeriodRows>['rows'],
  labels: number[],
  traceIds: string[],
  traceStepIndex: number[],
  perTraceSnaps: ReturnType<typeof extractPersonPeriodRows>['perTraceSnaps'],
  tracesById: Record<string, RawTrace>
): ModelEvalResult {
  const { fit, probs } = fitAndScore(featureNames, rows, labels);

  const tracePeak = new Map<string, number>();
  const traceAlarmStep = new Map<string, number>();
  traceIds.forEach((tid, i) => {
    tracePeak.set(tid, Math.max(tracePeak.get(tid) ?? 0, probs[i]));
    if (probs[i] >= ALARM_THRESHOLD && !traceAlarmStep.has(tid)) {
      traceAlarmStep.set(tid, traceStepIndex[i]);
    }
  });

  const uniqIds = [...new Set(traceIds)];
  const traceLabels = uniqIds.map((tid) => (tracesById[tid]?.ground_truth !== 'benign_success' ? 1 : 0));
  const traceScores = uniqIds.map((tid) => tracePeak.get(tid) ?? 0);
  const traceAlarmFlags = uniqIds.map((tid) => traceAlarmStep.has(tid));

  const leads: number[] = [];
  uniqIds.forEach((tid) => {
    if (tracesById[tid]?.ground_truth !== 'benign_success' && traceAlarmStep.has(tid)) {
      const total = perTraceSnaps[tid].snapshots.length;
      leads.push(total - 1 - traceAlarmStep.get(tid)!);
    }
  });
  const leadGain = leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : 0;

  return {
    model_name: modelName,
    feature_names: featureNames,
    auroc: auroc(traceScores, traceLabels),
    f1_score: f1AtAlarm(traceAlarmFlags, traceLabels),
    brier_score: brierScore(probs, labels),
    lead_time_gain_steps: leadGain,
    fit,
  };
}

export function computeAblationTable(traces: RawTrace[]): ModelEvalResult[] {
  const { rows, labels, traceIds, traceStepIndex, perTraceSnaps } = extractPersonPeriodRows(traces);
  const tracesById: Record<string, RawTrace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  const variants: [string, readonly FeatureName[]][] = [
    ['Stock-Only', ['stock']],
    ['Flow-Only', ['flow']],
    ['Stock+Flow (Additive)', ['stock', 'flow']],
    ['Full (Interaction + Controls)', FEATURE_ORDER],
  ];

  return variants.map(([name, feats]) =>
    evaluateModel(name, feats, rows, labels, traceIds, traceStepIndex, perTraceSnaps, tracesById)
  );
}

export const EvaluationEngine = {
  auroc,
  f1AtAlarm,
  brierScore,
  evaluateModel,
  computeAblationTable,
};
