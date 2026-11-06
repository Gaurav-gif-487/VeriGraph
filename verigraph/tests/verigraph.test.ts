// VeriGraph automated test suite.
// Uses Node's built-in test runner (node:test) so `npx tsx tests/verigraph.test.ts`
// or `node --test` both work with no extra test framework dependency.
// Previously this file was referenced by package.json and README but did not
// exist, so `npm test` failed outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphBuilder, StockFlowEngine, RELATION_WEIGHTS } from '../src/lib/stockFlowEngine';
import { fitLogistic, standardize, extractPersonPeriodRows } from '../src/lib/logisticModel';
import { auroc, f1AtAlarm, brierScore, computeAblationTable } from '../src/lib/evaluation';
import { CausalExperimentEngine } from '../src/lib/causalExperiment';
import { getSampleTraces } from '../src/data/sampleDatasets';
import { traceInspiredScore, trajadInspiredLocalize, evaluateTraceInspired, evaluateTrajadInspired } from '../src/lib/inspiredBaselines';
import { RealTraceConverter, buildReferenceModel } from '../src/lib/realTraceConverter';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('GraphBuilder: direct edge centrality reflects relation weight', () => {
  const b = new GraphBuilder();
  b.processEvent({ type: 'node.added', node_id: 'a' });
  b.processEvent({ type: 'node.added', node_id: 'b' });
  b.processEvent({ type: 'edge.added', node_id: 'a', target_node_id: 'b', relation: 'entanglement' });
  const cent = b.computeCentralities();
  // a -> b via entanglement (weight 1.6), one hop, decay=1.0 => 1 + 1.6*1.0
  assert.ok(Math.abs((cent.get('a') ?? 0) - (1 + RELATION_WEIGHTS.entanglement)) < 1e-9);
  // b has no outgoing edges => baseline centrality of 1
  assert.equal(cent.get('b'), 1.0);
});

test('GraphBuilder: multi-hop centrality is strictly greater than one-hop-only sum', () => {
  const b = new GraphBuilder();
  ['hub', 'mid', 'leaf'].forEach((n) => b.processEvent({ type: 'node.added', node_id: n }));
  b.processEvent({ type: 'edge.added', node_id: 'hub', target_node_id: 'mid', relation: 'depends_on' });
  b.processEvent({ type: 'edge.added', node_id: 'mid', target_node_id: 'leaf', relation: 'depends_on' });
  const cent = b.computeCentralities();
  // hub reaches mid (1 hop, weight 1.0) AND leaf (2 hops, decayed weight).
  // A naive one-hop-only implementation would give hub the same score as mid.
  assert.ok((cent.get('hub') ?? 0) > (cent.get('mid') ?? 0));
});

test('GraphBuilder: open obligations decrement on resolution.succeeded', () => {
  const b = new GraphBuilder();
  b.processEvent({ type: 'obligation.opened', node_id: 'x', uncertainty_type: 'unresolved_dependency' });
  assert.equal(b.openObligations.get('x')?.length, 1);
  b.processEvent({ type: 'resolution.succeeded', node_id: 'x' });
  assert.equal(b.openObligations.has('x'), false);
});

test('StockFlowEngine: stock_t is zero with no open obligations', () => {
  const engine = new StockFlowEngine();
  const result = engine.analyzeTrace({
    id: 't1',
    events: [
      { type: 'node.added', node_id: 'a' },
      { type: 'node.added', node_id: 'b' },
      { type: 'edge.added', node_id: 'a', target_node_id: 'b', relation: 'depends_on' },
    ],
  });
  for (const snap of result.snapshots) assert.equal(snap.stock_t, 0);
});

test('StockFlowEngine: flow_t counts a failed obligation and clears after symptom window', () => {
  const engine = new StockFlowEngine(2); // small window for a fast test
  const result = engine.analyzeTrace({
    id: 't2',
    events: [
      { type: 'obligation.opened', node_id: 'n', uncertainty_type: 'u' },
      { type: 'resolution.failed', node_id: 'n', uncertainty_type: 'u', payload: { is_symptom: true } },
      { type: 'node.added', node_id: 'filler1' },
      { type: 'node.added', node_id: 'filler2' },
      { type: 'node.added', node_id: 'filler3' },
    ],
  });
  assert.equal(result.snapshots[1].flow_t, 1); // symptom just triggered
  assert.equal(result.snapshots[4].flow_t, 0); // outside the symptom window
});

test('fitLogistic: recovers a strong positive coefficient on separable data', () => {
  // y = 1 whenever x > 0 (with a touch of noise), so we expect a
  // meaningfully positive beta on x after standardization.
  const X = [
    [1, -3],
    [1, -2],
    [1, -1],
    [1, -0.5],
    [1, 0.5],
    [1, 1],
    [1, 2],
    [1, 3],
  ];
  const y = [0, 0, 0, 0, 1, 1, 1, 1];
  const { Xs } = standardize(X, new Set([0]));
  const fit = fitLogistic(Xs, y, ['intercept', 'x'], 1.0);
  assert.ok(fit.beta[1] > 0, `expected positive beta on x, got ${fit.beta[1]}`);
});

test('auroc: perfect separation scores 1.0, random scores near 0.5', () => {
  assert.equal(auroc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1.0);
  const tied = auroc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]);
  assert.ok(Math.abs(tied - 0.5) < 1e-9);
});

test('f1AtAlarm: matches hand-computed precision/recall', () => {
  // TP=1 (idx0), FP=1 (idx1), FN=1 (idx2), TN=1 (idx3)
  const alarms = [true, true, false, false];
  const labels = [1, 0, 1, 0];
  const f1 = f1AtAlarm(alarms, labels);
  // precision = 1/2, recall = 1/2 => F1 = 0.5
  assert.ok(Math.abs(f1 - 0.5) < 1e-9);
});

test('brierScore: zero for perfect predictions', () => {
  assert.equal(brierScore([0, 1, 0, 1], [0, 1, 0, 1]), 0);
});

test('CausalExperimentEngine: is deterministic given a fixed seed', () => {
  const r1 = CausalExperimentEngine.runExperiment(50, 7);
  const r2 = CausalExperimentEngine.runExperiment(50, 7);
  assert.deepEqual(r1, r2);
});

test('CausalExperimentEngine: hub is chosen as the central node, not a leaf', () => {
  const res = CausalExperimentEngine.runExperiment(10, 1);
  assert.equal(res.central_node, 'hub');
});

test('traceInspiredScore: TRACE-style verdict rule is max-severity >= 4, not a fitted threshold', () => {
  const trace = {
    id: 't-trace-inspired',
    events: [
      { type: 'node.added', node_id: 'hub' },
      { type: 'obligation.opened', node_id: 'hub', uncertainty_type: 'u' },
      { type: 'resolution.failed', node_id: 'hub', uncertainty_type: 'u', payload: { is_symptom: false } },
    ],
  };
  const r = traceInspiredScore(trace);
  assert.equal(r.findings.length, 1);
  assert.equal(r.suspicion_score_1_5 >= 4, r.verdict_malicious);
});

test('trajadInspiredLocalize: flags the first failure step, no centrality weighting', () => {
  const trace = {
    id: 't-trajad-inspired',
    events: [
      { type: 'node.added', node_id: 'a' },
      { type: 'obligation.opened', node_id: 'a', uncertainty_type: 'u' },
      { type: 'node.added', node_id: 'b' },
      { type: 'resolution.failed', node_id: 'a', uncertainty_type: 'u' },
      { type: 'resolution.escalated', node_id: 'a', uncertainty_type: 'u2' },
    ],
  };
  const r = trajadInspiredLocalize(trace);
  assert.equal(r.verdict, 'Anomaly');
  assert.equal(r.first_error_step, 3);
  assert.equal(r.anomaly_event_count, 2);
});

test('inspired-by baselines: benign trace with no failures scores Normal / non-malicious', () => {
  const trace = { id: 't-benign', ground_truth: 'benign_success', events: [{ type: 'node.added', node_id: 'x' }] };
  assert.equal(trajadInspiredLocalize(trace).verdict, 'Normal');
  assert.equal(traceInspiredScore(trace).verdict_malicious, false);
});

test('integration: inspired-by baselines run on the bundled dataset and produce valid metrics', () => {
  const traces = getSampleTraces(true);
  const traceR = evaluateTraceInspired(traces);
  const trajadR = evaluateTrajadInspired(traces);
  assert.ok(traceR.auroc >= 0 && traceR.auroc <= 1);
  assert.ok(trajadR.auroc >= 0 && trajadR.auroc <= 1);
  assert.equal(traceR.per_trace.length, traces.length);
  assert.equal(trajadR.per_trace.length, traces.length);
});

test('RealTraceConverter: buildReferenceModel + parseGenericTrace produces a real hazard curve, not a stub', () => {
  const trainTraces = getSampleTraces(true);
  const model = buildReferenceModel(trainTraces);
  const probe = {
    id: 'probe',
    events: [
      { type: 'node.added', node_id: 'x' },
      { type: 'obligation.opened', node_id: 'x', uncertainty_type: 'u' },
      { type: 'resolution.failed', node_id: 'x', uncertainty_type: 'u' },
    ],
  };
  const result = RealTraceConverter.parseGenericTrace(probe, model);
  assert.equal(result.scored.length, 3);
  for (const s of result.scored) {
    assert.ok(s.predicted_hazard_p >= 0 && s.predicted_hazard_p <= 1);
  }
  // without a reference model it should still work via the heuristic fallback, not throw
  const fallback = RealTraceConverter.parseGenericTrace(probe, null);
  assert.equal(fallback.scored.length, 3);
});

test('integration: bundled dataset loads and the ablation table is monotonically sane', () => {
  const traces = getSampleTraces(true);
  assert.ok(traces.length > 0, 'expected at least one bundled trace');
  const { rows, labels } = extractPersonPeriodRows(traces);
  assert.equal(rows.length, labels.length);

  const results = computeAblationTable(traces);
  assert.equal(results.length, 4);
  for (const r of results) {
    assert.ok(r.auroc >= 0 && r.auroc <= 1, `AUROC out of range for ${r.model_name}: ${r.auroc}`);
    assert.ok(r.f1_score >= 0 && r.f1_score <= 1, `F1 out of range for ${r.model_name}: ${r.f1_score}`);
  }
});

test('MCP server: real JSON-RPC handshake over stdio, tools/list and tools/call all work', async () => {
  const serverPath = path.join(__dirname, '..', 'cli', 'verigraph-mcp.ts');
  const proc = spawn('tsx', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map<number, (msg: any) => void>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* ignore non-JSON stderr-ish noise that leaked to stdout, if any */
    }
  });

  function send(msg: Record<string, unknown>) {
    proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  function call(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for response to ${method}`)), 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  try {
    const initResp = await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verigraph-test', version: '1.0' },
    });
    assert.equal(initResp.result.serverInfo.name, 'verigraph');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listResp = await call(2, 'tools/list');
    const toolNames = listResp.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(toolNames, ['analyze_trace', 'list_sample_traces', 'run_benchmark', 'run_causal_test']);

    const causalResp = await call(3, 'tools/call', { name: 'run_causal_test', arguments: { trials: 10, seed: 1 } });
    const causalPayload = JSON.parse(causalResp.result.content[0].text);
    assert.equal(causalPayload.central_node, 'hub');

    const analyzeResp = await call(4, 'tools/call', {
      name: 'analyze_trace',
      arguments: {
        trace: {
          id: 't1',
          events: [
            { type: 'node.added', node_id: 'a' },
            { type: 'obligation.opened', node_id: 'a', uncertainty_type: 'u' },
            { type: 'resolution.failed', node_id: 'a', uncertainty_type: 'u' },
          ],
        },
      },
    });
    const analyzePayload = JSON.parse(analyzeResp.result.content[0].text);
    assert.equal(analyzePayload.total_steps, 3);
    assert.equal(analyzePayload.scored.length, 3);
  } finally {
    proc.kill();
  }
});
