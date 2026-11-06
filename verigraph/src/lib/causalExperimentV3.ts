// VeriGraph: causal intervention experiment, v3.
//
// WHY THIS FILE EXISTS (see causalExperiment.ts's header and the README):
// The original `causalExperiment.ts` sets
//   P(failure | node) = baseRate + 0.8 * (centrality(node) / maxCentrality)
// i.e. centrality is a direct input to the formula that generates the
// outcome. A chi-square test on data generated that way can never return
// "hypothesis not supported" -- it isn't measuring anything about the graph,
// it's just checking that the RNG followed the formula it was handed.
//
// This version removes centrality from the outcome-generating process
// entirely. Centrality is computed once, independently, from
// GraphBuilder.computeCentralities() (unchanged). The *outcome* comes from a
// separate, centrality-blind contagion simulation: starting from the
// injected node, each *existing graph edge* independently propagates a
// fault with a single fixed probability (not weighted by centrality, not
// weighted by edge type), plus a small independent background-noise rate
// so both arms have real variance instead of a trivial 0%/100% floor.
// "Failure" = the fault reaches a designated critical sink node other than
// the injection point itself.
//
// v3 fixes a SECOND issue: v2 propagates a fault along OUTGOING edges from
// the injected node (as if a corrupted node contaminates whatever it
// calls) and ranks "central" by out-centrality. For an ordinary defect --
// not a malicious/corrupting node, just a bug -- the more natural
// direction is the other way: a bug in a low-level function breaks its
// CALLERS (they get a wrong return value from it), not the things it
// calls. That's the scenario the stock/flow thesis is actually about (an
// unresolved obligation at node X should threaten whatever depends on X's
// output). v3 propagates along REVERSED edges (from the injected node to
// its consumers, then their consumers) and ranks "central" by
// GraphBuilder.computeConsumerCentralities() instead of computeCentralities().
//
// NOTE: reversing the edge direction in v3 is a design choice based on
// ordinary call-graph semantics (a callee's bug is visible to its callers
// through its return value; a caller's bug is not generally visible to its
// callees). It has not been validated against real fault-injection data.
// The ky mutation-testing run measures kill/survive rates, which say
// nothing about propagation direction.
//
// v2 is kept, unmodified, for the outward-corruption scenario, which is a
// real (if different) failure mode -- see the README for when each model
// applies.
//
// This is still a synthetic graph, not a real agent trajectory -- that
// caveat from causalExperiment.ts still applies in full.

import { GraphBuilder, TraceEvent } from './stockFlowEngine';

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

export interface CausalResultV3 {
  central_node: string;
  peripheral_node: string;
  central_centrality: number;
  peripheral_centrality: number;
  critical_sink_nodes: string[];
  edge_propagation_probability: number;
  background_noise_rate: number;
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
  return 1 - sign * y;
}

export const CausalExperimentEngineV3 = {
  runExperiment(
    trials = 30,
    seed = 42,
    edgeProp = 0.6,
    backgroundNoise = 0.05
  ): CausalResultV3 {
    const rng = mulberry32(seed);
    const builder = buildSyntheticGraph();
    const cent = builder.computeConsumerCentralities();

    // Central/peripheral chosen only from nodes that have at least one
    // CONSUMER (incoming edge) -- an injected node nobody calls can never
    // propagate a defect to anything by construction, which would make
    // that arm's 0% rate a topology tautology rather than a measured
    // result. (This is the mirror image of v2's outDegree filter, flipped
    // because propagation now runs against edge direction.)
    const inDegree = new Map<string, number>();
    for (const e of builder.edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    const injectable = [...cent.entries()].filter(([n]) => (inDegree.get(n) ?? 0) > 0);
    injectable.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const [centralNode, centralCentrality] = injectable[0];
    const [peripheralNode, peripheralCentrality] = injectable[injectable.length - 1];

    // Critical sinks (here: critical ROOTS): nodes with no incoming edges,
    // i.e. top-level entrypoints that nothing else calls. In the reversed
    // propagation model these are where a defect ends up if it climbs all
    // the way up the call chain -- the equivalent of v2's "terminal
    // artifact," but at the opposite end of the graph.
    const criticalSinks = [...cent.keys()].filter((n) => (inDegree.get(n) ?? 0) === 0);

    const adj = new Map<string, string[]>();
    for (const e of builder.edges) {
      // Reversed: propagate from callee (e.target) to caller (e.source).
      const l = adj.get(e.target) ?? [];
      l.push(e.source);
      adj.set(e.target, l);
    }
    const allNodes = [...cent.keys()];

    const runTrial = (injectedNode: string): boolean => {
      const faulted = new Set<string>([injectedNode]);
      // Fixed-point propagation: repeatedly sweep edges; each edge out of an
      // already-faulted node independently fires w.p. edgeProp. Bounded by
      // |nodes| sweeps (graph is finite and this is a small synthetic graph).
      for (let sweep = 0; sweep < allNodes.length; sweep++) {
        let changed = false;
        for (const n of [...faulted]) {
          for (const tgt of adj.get(n) ?? []) {
            if (!faulted.has(tgt) && rng() < edgeProp) {
              faulted.add(tgt);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      // Independent background noise: a critical sink can fail for reasons
      // unrelated to this injection, so neither arm has a trivial 0% floor.
      if (rng() < backgroundNoise) {
        faulted.add(criticalSinks[Math.floor(rng() * criticalSinks.length)]);
      }
      return criticalSinks.some((s) => s !== injectedNode && faulted.has(s));
    };

    let centralFailures = 0;
    let peripheralFailures = 0;
    for (let t = 0; t < trials; t++) if (runTrial(centralNode)) centralFailures++;
    for (let t = 0; t < trials; t++) if (runTrial(peripheralNode)) peripheralFailures++;

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
      central_centrality: Math.round(centralCentrality * 1000) / 1000,
      peripheral_centrality: Math.round(peripheralCentrality * 1000) / 1000,
      critical_sink_nodes: criticalSinks,
      edge_propagation_probability: edgeProp,
      background_noise_rate: backgroundNoise,
      central_failure_rate: centralRate,
      peripheral_failure_rate: peripheralRate,
      chi_square: Math.round(chi2 * 1000) / 1000,
      p_value_outcome_difference: pValue,
      centrality_mechanism_supported: centralRate > peripheralRate && pValue < 0.05,
    };
  },
};

// NOTE ON THE RESULT (found by actually running this, not predicted in
// advance): on the small synthetic graph in this file, v3 consistently
// shows PERIPHERAL nodes failing MORE often than the "central" one, and
// several seeds are individually significant in that direction. Reason:
// leaf_d (highest consumer-centrality, chosen as "central") is two
// propagation hops from the nearest critical root (leaf_d -> leaf_c ->
// hub), so reaching it needs edgeProp^2. leaf_c (chosen as "peripheral",
// lower consumer-centrality) is one hop from the same root (leaf_c ->
// hub), needing only edgeProp^1. Since edgeProp=0.6 < 1, being ONE hop
// closer to the critical outcome matters more than having a higher
// cumulative (hop-decayed, sum-over-everything-reachable) centrality
// score. This suggests computeConsumerCentralities()'s blast-radius SUM
// may be the wrong shape of metric for "probability of reaching a
// specific critical node" -- shortest-path distance to the nearest
// critical node might predict better than total decayed reachability.
// That's a real, falsifiable, next thing to check -- not fixed here,
// because fixing it without a real dataset to check it against would just
// be swapping one un-validated formula for another.
