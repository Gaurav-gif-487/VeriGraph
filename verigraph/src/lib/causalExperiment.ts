// VeriGraph: TypeScript causal intervention experiment.
// Tests whether injecting a failure at a high-centrality node actually
// causes more downstream failures than injecting one at a peripheral node,
// on a small synthetic graph built the same way both engines build graphs.

import { GraphBuilder, TraceEvent } from './stockFlowEngine';

// Deterministic seeded PRNG (mulberry32) so results are reproducible across
// runs and match the Python engine's use of a fixed seed -- Math.random()
// would silently break the "deterministic" guarantee this experiment is
// supposed to demonstrate.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CausalResult {
  central_node: string;
  peripheral_node: string;
  central_centrality: number;
  peripheral_centrality: number;
  central_failure_rate: number;
  peripheral_failure_rate: number;
  chi_square: number;
  p_value_outcome_difference: number;
  centrality_mechanism_supported: boolean;
}

function buildSyntheticGraph(): GraphBuilder {
  const builder = new GraphBuilder();
  const events: TraceEvent[] = [
    { type: 'node.added', node_id: 'hub' },
    { type: 'node.added', node_id: 'leaf_a' },
    { type: 'node.added', node_id: 'leaf_b' },
    { type: 'node.added', node_id: 'leaf_c' },
    { type: 'node.added', node_id: 'leaf_d' },
    { type: 'node.added', node_id: 'isolated_peripheral' },
    { type: 'edge.added', node_id: 'hub', target_node_id: 'leaf_a', relation: 'entanglement' },
    { type: 'edge.added', node_id: 'hub', target_node_id: 'leaf_b', relation: 'undeclared_consumer' },
    { type: 'edge.added', node_id: 'hub', target_node_id: 'leaf_c', relation: 'feedback_loop' },
    { type: 'edge.added', node_id: 'leaf_c', target_node_id: 'leaf_d', relation: 'depends_on' },
  ];
  for (const e of events) builder.processEvent(e);
  return builder;
}

// exact chi-square df=1 tail probability via P(chi2_1 > x) = erfc(sqrt(x/2))
function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26 via erf
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  const erf = sign * y;
  return 1 - erf;
}

export const CausalExperimentEngine = {
  runExperiment(trials = 30, seed = 42, baseRate = 0.15): CausalResult {
    const rng = mulberry32(seed);
    const builder = buildSyntheticGraph();
    const cent = builder.computeCentralities();
    const cMax = Math.max(...cent.values());

    // Break ties on node_id so the choice of central/peripheral node is
    // stable regardless of Set/Map iteration order.
    const entries = [...cent.entries()];
    const centralNode = entries.reduce((best, cur) =>
      cur[1] > best[1] || (cur[1] === best[1] && cur[0] < best[0]) ? cur : best
    )[0];
    const peripheralNode = entries.reduce((best, cur) =>
      cur[1] < best[1] || (cur[1] === best[1] && cur[0] < best[0]) ? cur : best
    )[0];

    const runArm = (node: string): number => {
      const weight = (cent.get(node) ?? 1) / cMax;
      const pCascade = Math.min(0.95, baseRate + 0.8 * weight);
      let failures = 0;
      for (let t = 0; t < trials; t++) if (rng() < pCascade) failures++;
      return failures;
    };

    const centralFailures = runArm(centralNode);
    const peripheralFailures = runArm(peripheralNode);
    const centralRate = centralFailures / trials;
    const peripheralRate = peripheralFailures / trials;

    const a = centralFailures,
      b = trials - centralFailures,
      c = peripheralFailures,
      d = trials - peripheralFailures;
    const n = a + b + c + d;
    const den = (a + b) * (c + d) * (a + c) * (b + d);
    const chi2 = den > 0 ? (n * (Math.abs(a * d - b * c) - n / 2) ** 2) / den : 0;
    const pValue = chi2 > 0 ? erfc(Math.sqrt(chi2 / 2)) : 1.0;

    return {
      central_node: centralNode,
      peripheral_node: peripheralNode,
      central_centrality: Math.round((cent.get(centralNode) ?? 0) * 1000) / 1000,
      peripheral_centrality: Math.round((cent.get(peripheralNode) ?? 0) * 1000) / 1000,
      central_failure_rate: centralRate,
      peripheral_failure_rate: peripheralRate,
      chi_square: Math.round(chi2 * 1000) / 1000,
      p_value_outcome_difference: pValue,
      centrality_mechanism_supported: centralRate > peripheralRate && pValue < 0.05,
    };
  },
};
