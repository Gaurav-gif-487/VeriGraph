import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { getSampleTracesBrowser } from '../../data/sampleDatasets.browser';
import { buildReferenceModel, RealTraceConverter, ScoredTrace } from '../../lib/realTraceConverter';
import { ALARM_THRESHOLD } from '../../lib/stockFlowEngine';
import type { RawTrace } from '../../lib/logisticModel';

const SAMPLE_PLACEHOLDER = `{
  "id": "example",
  "events": [
    { "type": "node.added", "node_id": "cache_layer" },
    { "type": "node.added", "node_id": "db_writer" },
    { "type": "edge.added", "node_id": "cache_layer", "target_node_id": "db_writer", "relation": "entanglement" },
    { "type": "obligation.opened", "node_id": "cache_layer", "uncertainty_type": "stale_write_check" },
    { "type": "resolution.attempted", "node_id": "cache_layer", "uncertainty_type": "stale_write_check" },
    { "type": "resolution.failed", "node_id": "cache_layer", "uncertainty_type": "stale_write_check", "payload": { "is_symptom": true } }
  ]
}`;

function verdictClass(v: string) {
  if (v === 'ALARM') return 'alarm';
  if (v === 'VERIFY') return 'verify';
  return 'nominal';
}

export default function AnalyzeView() {
  const sampleTraces = useMemo(() => getSampleTracesBrowser(), []);
  const referenceModel = useMemo(() => buildReferenceModel(sampleTraces), [sampleTraces]);

  const [selectedSampleId, setSelectedSampleId] = useState<string>('__custom__');
  const [rawInput, setRawInput] = useState(SAMPLE_PLACEHOLDER);
  const [result, setResult] = useState<ScoredTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  function runAnalysis(text: string) {
    setError(null);
    try {
      const parsed = JSON.parse(text) as RawTrace;
      const scored = RealTraceConverter.parseGenericTrace(parsed, referenceModel);
      setResult(scored);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onSelectSample(id: string) {
    setSelectedSampleId(id);
    if (id === '__custom__') return;
    const tr = sampleTraces.find((t) => t.id === id);
    if (tr) {
      const text = JSON.stringify(tr, null, 2);
      setRawInput(text);
      runAnalysis(text);
    }
  }

  const chartData = result?.scored.map((s) => ({ step: s.step, hazard: s.predicted_hazard_p })) ?? [];

  return (
    <div>
      <div className="view-header">
        <div className="view-eyebrow">02 · Analyze</div>
        <h1 className="view-title">Analyze a trace</h1>
        <p className="view-description">
          Paste an event log, or pick one of the 25 bundled traces, and it runs through the real
          stock/flow engine plus the hazard model fit on this device -- the same{' '}
          <code className="inline">RealTraceConverter.parseGenericTrace()</code> the CLI and MCP
          server call.
        </p>
      </div>

      <div className="panel">
        <div className="control-row" style={{ marginBottom: 14 }}>
          <div>
            <label className="field-label">Load a bundled sample</label>
            <select value={selectedSampleId} onChange={(e) => onSelectSample(e.target.value)}>
              <option value="__custom__">-- paste your own below --</option>
              {sampleTraces.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} ({t.ground_truth})
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={() => runAnalysis(rawInput)}>
            Run analysis
          </button>
        </div>
        <label className="field-label">Trace event log (JSON)</label>
        <textarea
          className="trace-input"
          value={rawInput}
          onChange={(e) => {
            setRawInput(e.target.value);
            setSelectedSampleId('__custom__');
          }}
          spellCheck={false}
        />
        {error && <div className="error-box" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {result && (
        <>
          <div className="panel">
            <h2 className="panel-title">
              {result.trace_id}
              <span className="tabular" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {result.total_steps} steps
              </span>
            </h2>
            <p className="panel-subtitle">Recorder strip -- one segment per step, colored by verdict.</p>
            <div className="hazard-tape">
              {result.scored.map((s) => (
                <div
                  key={s.step}
                  className={`hazard-tape-segment ${verdictClass(s.verdict)}`}
                  title={`step ${s.step}: ${(s.predicted_hazard_p * 100).toFixed(1)}% (${s.verdict})`}
                />
              ))}
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">Hazard probability over time</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#262d34" vertical={false} />
                <XAxis dataKey="step" tick={{ fill: '#8b95a1', fontSize: 10 }} stroke="#262d34" />
                <YAxis domain={[0, 1]} tick={{ fill: '#8b95a1', fontSize: 10 }} stroke="#262d34" />
                <Tooltip
                  contentStyle={{ background: '#171c21', border: '1px solid #262d34', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#e7ecef' }}
                  formatter={(v) => [`${(Number(v) * 100).toFixed(1)}%`, 'hazard']}
                />
                <ReferenceLine y={ALARM_THRESHOLD} stroke="#f0555b" strokeDasharray="4 4" label={{ value: 'alarm threshold', fill: '#f0555b', fontSize: 10, position: 'insideTopLeft' }} />
                <Line type="monotone" dataKey="hazard" stroke="#57a6ff" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="panel">
            <h2 className="panel-title">Step-by-step</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Stock</th>
                  <th>Flow</th>
                  <th>Stock&times;Flow</th>
                  <th>Hazard</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {result.scored.map((s) => (
                  <tr key={s.step}>
                    <td>{s.step}</td>
                    <td>{s.stock_t.toFixed(2)}</td>
                    <td>{s.flow_t}</td>
                    <td>{s.stock_times_flow.toFixed(2)}</td>
                    <td>{(s.predicted_hazard_p * 100).toFixed(1)}%</td>
                    <td>
                      <span className={`chip chip-${verdictClass(s.verdict)}`}>{s.verdict}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2 className="panel-title">Highest-impact next action</h2>
            {result.highest_impact_action ? (
              <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                Resolve open obligation(s) on <code className="inline">{result.highest_impact_action.node}</code> --
                centrality <span className="tabular">{result.highest_impact_action.centrality.toFixed(2)}</span>,{' '}
                <span className="tabular">{result.highest_impact_action.unresolved_count}</span> unresolved.
              </p>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>No open obligations remaining.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
