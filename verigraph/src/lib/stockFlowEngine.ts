// VeriGraph: TypeScript Stock/Flow Engine
// Direct port of python/verigraph.py's GraphBuilder + StockFlowCalculator so
// the TS CLI computes the same numbers as the Python reference engine,
// instead of importing modules that never existed.

export const RELATION_WEIGHTS: Record<string, number> = {
  entanglement: 1.6,
  undeclared_consumer: 1.4,
  feedback_loop: 1.3,
  depends_on: 1.0,
  data_flow: 1.0,
  direct_call: 1.0,
};

export const HOP_DECAY = 0.65; // per-hop attenuation for blast-radius centrality
export const SYMPTOM_WINDOW = 5;
export const ALARM_THRESHOLD = 0.58;

export interface TraceEvent {
  type: string;
  node_id?: string;
  target_node_id?: string;
  relation?: string;
  uncertainty_type?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Edge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface Snapshot {
  step: number;
  stock_t: number;
  flow_t: number;
  stock_times_flow: number;
  delta_stock_existing_t: number;
  new_node_stock_t: number;
  raw_unresolved_count: number;
  node_count: number;
  edge_count: number;
}

export interface AnalyzedTrace {
  trace_id: string;
  name: string;
  total_steps: number;
  snapshots: Snapshot[];
}

/**
 * Deterministic dependency graph built from a stream of typed events.
 * Tracks nodes, weighted edges, and open verification obligations per node.
 */
export class GraphBuilder {
  nodes: Set<string> = new Set();
  edges: Edge[] = [];
  openObligations: Map<string, string[]> = new Map();

  processEvent(event: TraceEvent): void {
    const etype = event.type;
    const nid = event.node_id;

    if (etype === 'node.added') {
      if (nid) this.nodes.add(nid);
    } else if (etype === 'edge.added') {
      const target = event.target_node_id;
      const rel = event.relation || 'depends_on';
      if (nid && target) {
        this.nodes.add(nid);
        this.nodes.add(target);
        this.edges.push({ source: nid, target, relation: rel, weight: RELATION_WEIGHTS[rel] ?? 1.0 });
      }
    } else if (etype === 'obligation.opened') {
      const utype = event.uncertainty_type || 'unresolved_dependency';
      if (nid) {
        this.nodes.add(nid);
        const list = this.openObligations.get(nid) ?? [];
        list.push(utype);
        this.openObligations.set(nid, list);
      }
    } else if (etype === 'resolution.succeeded') {
      if (nid && this.openObligations.has(nid)) {
        const list = this.openObligations.get(nid)!;
        if (list.length > 0) {
          list.pop();
          if (list.length === 0) this.openObligations.delete(nid);
        }
      }
    }
  }

  /**
   * Blast-radius centrality: 1 + weighted, hop-decayed count of nodes
   * transitively reachable downstream of v, where each edge contributes its
   * Sculley antipattern severity weight. A node at the root of a long
   * entangled chain scores higher than a node with a single direct edge --
   * this is a multi-hop BFS, not a one-hop out-degree sum.
   */
  computeCentralities(): Map<string, number> {
    const adj = new Map<string, [string, number][]>();
    for (const e of this.edges) {
      const list = adj.get(e.source) ?? [];
      list.push([e.target, e.weight]);
      adj.set(e.source, list);
    }

    const centralities = new Map<string, number>();
    for (const n of this.nodes) {
      const visited = new Set<string>([n]);
      const queue: [string, number][] = [[n, 1.0]];
      let total = 0.0;
      let qi = 0;
      while (qi < queue.length) {
        const [cur, decay] = queue[qi++];
        for (const [tgt, w] of adj.get(cur) ?? []) {
          if (!visited.has(tgt)) {
            visited.add(tgt);
            total += w * decay;
            queue.push([tgt, decay * HOP_DECAY]);
          }
        }
      }
      centralities.set(n, 1.0 + total);
    }
    return centralities;
  }

  /**
   * Consumer ("who depends on me") centrality: same blast-radius BFS as
   * computeCentralities(), but walked over the REVERSED edge set -- how
   * much of the graph transitively calls/depends on v, not how much v
   * calls outward.
   *
   * Added after real_mutation_experiment.json (see real-experiment-toolkit)
   * showed computeCentralities() predicting the WRONG direction of blast
   * radius for the stock/flow hypothesis on real code: a hub function that
   * calls everything but that nothing else calls (e.g. a top-level
   * entrypoint) scores highest on computeCentralities() but breaking it only
   * ever fails its own direct caller -- it has no downstream consumers to
   * cascade into. A leaf function called from many places scores low on
   * computeCentralities() but breaking it fails every caller. For "if this
   * node's obligation fails, how much of the system is put at risk,"
   * consumer centrality is the more relevant of the two; computeCentralities()
   * is kept as-is (unchanged, still used by analyze/benchmark) so existing
   * numbers stay comparable, but callers computing risk/priority should
   * use this method instead, or report both like causal-test-v2 does.
   */
  computeConsumerCentralities(): Map<string, number> {
    const radj = new Map<string, [string, number][]>();
    for (const e of this.edges) {
      const list = radj.get(e.target) ?? [];
      list.push([e.source, e.weight]);
      radj.set(e.target, list);
    }

    const centralities = new Map<string, number>();
    for (const n of this.nodes) {
      const visited = new Set<string>([n]);
      const queue: [string, number][] = [[n, 1.0]];
      let total = 0.0;
      let qi = 0;
      while (qi < queue.length) {
        const [cur, decay] = queue[qi++];
        for (const [src, w] of radj.get(cur) ?? []) {
          if (!visited.has(src)) {
            visited.add(src);
            total += w * decay;
            queue.push([src, decay * HOP_DECAY]);
          }
        }
      }
      centralities.set(n, 1.0 + total);
    }
    return centralities;
  }
}

interface ObligationState {
  status: 'open' | 'attempted' | 'resolved' | 'symptom' | 'failed';
  step: number;
}

/**
 * Walks a trace's event log step by step, maintaining the dependency graph
 * and computing stock_t / flow_t (and their decomposition) at every step.
 */
export class StockFlowEngine {
  symptomWindow: number;

  constructor(symptomWindow: number = SYMPTOM_WINDOW) {
    this.symptomWindow = symptomWindow;
  }

  analyzeTrace(traceDict: { id?: string; name?: string; events?: TraceEvent[] }): AnalyzedTrace {
    const events = traceDict.events ?? [];
    const builder = new GraphBuilder();
    const snapshots: Snapshot[] = [];
    const obligationStatus = new Map<string, ObligationState>();

    let prevNodes = new Set<string>();
    let prevCent = new Map<string, number>();
    let prevUnres = new Map<string, number>();

    events.forEach((ev, step) => {
      builder.processEvent(ev);
      const currNodes = new Set(builder.nodes);
      const cent = builder.computeCentralities();

      const etype = ev.type;
      const nid = ev.node_id ?? '';
      const utype = ev.uncertainty_type || 'unresolved_dependency';
      const k = `${nid}::${utype}`;

      if (etype === 'obligation.opened') {
        obligationStatus.set(k, { status: 'open', step });
      } else if (etype === 'resolution.attempted') {
        const cur = obligationStatus.get(k);
        if (cur && cur.status !== 'resolved') obligationStatus.set(k, { status: 'attempted', step });
      } else if (etype === 'resolution.succeeded') {
        if (obligationStatus.has(k)) obligationStatus.set(k, { status: 'resolved', step });
      } else if (etype === 'resolution.failed' || etype === 'resolution.escalated') {
        const isSymptom = Boolean(ev.payload?.is_symptom);
        obligationStatus.set(k, { status: isSymptom ? 'symptom' : 'failed', step });
      }

      let stockT = 0;
      let rawUnres = 0;
      const currUnres = new Map<string, number>();
      for (const n of currNodes) {
        const cnt = builder.openObligations.get(n)?.length ?? 0;
        currUnres.set(n, cnt);
        rawUnres += cnt;
        stockT += (cent.get(n) ?? 1.0) * cnt;
      }

      let deltaExisting = 0;
      let newNodeStock = 0;
      for (const n of currNodes) {
        if (prevNodes.has(n)) {
          deltaExisting +=
            (cent.get(n) ?? 1.0) * (currUnres.get(n) ?? 0) - (prevCent.get(n) ?? 1.0) * (prevUnres.get(n) ?? 0);
        } else {
          newNodeStock += (cent.get(n) ?? 1.0) * (currUnres.get(n) ?? 0);
        }
      }

      let failedCount = 0;
      let symptomCount = 0;
      for (const v of obligationStatus.values()) {
        if (v.status === 'failed') failedCount++;
        else if (v.status === 'symptom' && step - v.step <= this.symptomWindow) symptomCount++;
      }
      const flowT = failedCount + symptomCount;
      const stockXFlow = stockT * flowT;

      snapshots.push({
        step,
        stock_t: round3(stockT),
        flow_t: flowT,
        stock_times_flow: round3(stockXFlow),
        delta_stock_existing_t: round3(deltaExisting),
        new_node_stock_t: round3(newNodeStock),
        raw_unresolved_count: rawUnres,
        node_count: currNodes.size,
        edge_count: builder.edges.length,
      });

      prevNodes = currNodes;
      prevCent = new Map(cent);
      prevUnres = new Map(currUnres);
    });

    return {
      trace_id: traceDict.id ?? 'trace',
      name: traceDict.name ?? '',
      total_steps: events.length,
      snapshots,
    };
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
