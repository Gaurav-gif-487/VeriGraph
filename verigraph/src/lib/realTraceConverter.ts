// VeriGraph: converts an arbitrary (user-supplied) trace JSON into an
// analyzed snapshot sequence, and scores each step against a hazard model
// fit on the bundled reference dataset. This is what `verigraph.ts analyze`
// actually needs to produce real hazard percentages instead of a stub.

import { StockFlowEngine, GraphBuilder, AnalyzedTrace, ALARM_THRESHOLD } from './stockFlowEngine';
import { FEATURE_ORDER, DIFFICULTY_MAP, fitAndScore, extractPersonPeriodRows, RawTrace, FitAndScoreResult } from './logisticModel';

export interface ScoredSnapshot {
  step: number;
  stock_t: number;
  flow_t: number;
  stock_times_flow: number;
  predicted_hazard_p: number;
  is_alarm_triggered: boolean;
  verdict: 'ALARM' | 'VERIFY' | 'Nominal';
}

export interface ScoredTrace extends AnalyzedTrace {
  scored: ScoredSnapshot[];
  highest_impact_action: { node: string; centrality: number; unresolved_count: number } | null;
}

/**
 * Fits the reference hazard model once on a training set. Callers (CLI,
 * MCP server, browser app) each own how they obtain `trainTraces` --
 * Node callers read the bundled dataset off disk, the browser app bundles
 * it via Vite's JSON import. This module has no filesystem dependency of
 * its own, so it works unmodified in either environment.
 */
export function buildReferenceModel(trainTraces: RawTrace[]): FitAndScoreResult {
  const { rows, labels } = extractPersonPeriodRows(trainTraces);
  return fitAndScore(FEATURE_ORDER, rows, labels);
}

export const RealTraceConverter = {
  /**
   * Parses a generic (non-fixture-format) trace object: any object with an
   * `events` array of {type, node_id, target_node_id, relation,
   * uncertainty_type, payload} records. Fields beyond `events` (id, name,
   * ground_truth, task_difficulty) are used opportunistically if present.
   *
   * `referenceModel` should come from `buildReferenceModel()`; if omitted,
   * falls back to a simple stock*flow heuristic (still real math, just not
   * the fitted hazard model) rather than throwing.
   */
  parseGenericTrace(raw: RawTrace, referenceModel: FitAndScoreResult | null = null): ScoredTrace {
    const engine = new StockFlowEngine();
    const analyzed = engine.analyzeTrace(raw);
    const nSteps = analyzed.snapshots.length;
    const diff = DIFFICULTY_MAP[raw.task_difficulty ?? 'medium'] ?? 1.0;
    const model = referenceModel;

    const scored: ScoredSnapshot[] = analyzed.snapshots.map((s, i) => {
      let hazard: number;
      if (model) {
        const feat: Record<string, number> = {
          stock: s.stock_t,
          flow: s.flow_t,
          stock_x_flow: s.stock_times_flow,
          delta_stock_existing: s.delta_stock_existing_t,
          new_node_stock: s.new_node_stock_t,
          step_frac: (i + 1) / nSteps,
          nodes_seen: s.node_count,
          task_difficulty: diff,
        };
        const x = [1.0, ...FEATURE_ORDER.map((f) => feat[f])];
        const xs = x.map((v, j) => (j === 0 ? v : (v - model.means[j]) / model.stds[j]));
        const eta = xs.reduce((acc, v, j) => acc + v * model.fit.beta[j], 0);
        hazard = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
      } else {
        hazard = Math.min(0.99, s.stock_times_flow / 20);
      }
      const alarm = hazard >= ALARM_THRESHOLD;
      const verdict: ScoredSnapshot['verdict'] = alarm ? 'ALARM' : hazard >= ALARM_THRESHOLD * 0.6 ? 'VERIFY' : 'Nominal';
      return {
        step: s.step,
        stock_t: s.stock_t,
        flow_t: s.flow_t,
        stock_times_flow: s.stock_times_flow,
        predicted_hazard_p: Math.round(hazard * 10000) / 10000,
        is_alarm_triggered: alarm,
        verdict,
      };
    });

    const builder = new GraphBuilder();
    for (const ev of raw.events ?? []) builder.processEvent(ev);
    const cent = builder.computeCentralities();
    let highestImpact: ScoredTrace['highest_impact_action'] = null;
    if (builder.openObligations.size > 0) {
      let worstNode = '';
      let worstScore = -Infinity;
      for (const [node, list] of builder.openObligations) {
        const score = (cent.get(node) ?? 1) * list.length;
        if (score > worstScore) {
          worstScore = score;
          worstNode = node;
        }
      }
      highestImpact = {
        node: worstNode,
        centrality: Math.round((cent.get(worstNode) ?? 1) * 100) / 100,
        unresolved_count: builder.openObligations.get(worstNode)?.length ?? 0,
      };
    }

    return { ...analyzed, scored, highest_impact_action: highestImpact };
  },
};
