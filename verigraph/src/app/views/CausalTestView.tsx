import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { CausalExperimentEngine, CausalResult } from '../../lib/causalExperiment';

export default function CausalTestView() {
  const [trials, setTrials] = useState(50);
  const [seed, setSeed] = useState(42);
  const [result, setResult] = useState<CausalResult | null>(null);

  function run() {
    setResult(CausalExperimentEngine.runExperiment(trials, seed));
  }

  const chartData = result
    ? [
        { name: `central (${result.central_node})`, rate: result.central_failure_rate, fill: '#f0555b' },
        { name: `peripheral (${result.peripheral_node})`, rate: result.peripheral_failure_rate, fill: '#57a6ff' },
      ]
    : [];

  return (
    <div>
      <div className="view-header">
        <div className="view-eyebrow">03 · Causal Test</div>
        <h1 className="view-title">Centrality causal intervention</h1>
        <p className="view-description">
          Injects synthetic failures at a high-centrality node vs. a peripheral node on a small
          synthetic graph, and checks whether high centrality actually causes more downstream
          failures -- a chi-square test, not just a correlation. Uses a deterministic seeded PRNG
          (mulberry32), so the same seed always reproduces the same result. Note: this will differ
          slightly from the Python engine's numbers for the same seed/trials -- they use
          independent PRNGs, not a shared one.
        </p>
      </div>

      <div className="panel">
        <div className="control-row">
          <div>
            <label className="field-label">Trials per arm</label>
            <input type="number" min={1} max={2000} value={trials} onChange={(e) => setTrials(Number(e.target.value))} />
          </div>
          <div>
            <label className="field-label">Seed</label>
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </div>
          <button className="btn btn-primary" onClick={run}>
            Run experiment
          </button>
        </div>
      </div>

      {result && (
        <>
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-cell-label">Central node</div>
              <div className="stat-cell-value tabular" style={{ fontSize: 14 }}>
                {result.central_node} ({result.central_centrality.toFixed(2)})
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-cell-label">Peripheral node</div>
              <div className="stat-cell-value tabular" style={{ fontSize: 14 }}>
                {result.peripheral_node} ({result.peripheral_centrality.toFixed(2)})
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-cell-label">&chi;&sup2; (df=1)</div>
              <div className="stat-cell-value tabular">{result.chi_square.toFixed(3)}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-cell-label">p-value</div>
              <div className="stat-cell-value tabular">{result.p_value_outcome_difference.toExponential(2)}</div>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">
              Failure rate by injection site
              <span className={`chip ${result.centrality_mechanism_supported ? 'chip-nominal' : 'chip-alarm'}`}>
                {result.centrality_mechanism_supported ? 'HYPOTHESIS SUPPORTED' : 'NOT SUPPORTED'}
              </span>
            </h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid stroke="#262d34" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#8b95a1', fontSize: 11 }} stroke="#262d34" />
                <YAxis domain={[0, 1]} tick={{ fill: '#8b95a1', fontSize: 10 }} stroke="#262d34" />
                <Tooltip
                  contentStyle={{ background: '#171c21', border: '1px solid #262d34', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#e7ecef' }}
                  formatter={(v) => [`${(Number(v) * 100).toFixed(1)}%`, 'failure rate']}
                />
                <Bar dataKey="rate" radius={[3, 3, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
