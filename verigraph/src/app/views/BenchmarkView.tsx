import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { getSampleTracesBrowser } from '../../data/sampleDatasets.browser';
import { extractPersonPeriodRows } from '../../lib/logisticModel';
import { computeAblationTable } from '../../lib/evaluation';
import { evaluateTraceInspired, evaluateTrajadInspired } from '../../lib/inspiredBaselines';

const BAR_COLORS = ['#57a6ff', '#57a6ff', '#57a6ff', '#34d399', '#f2a93b', '#f2a93b'];

export default function BenchmarkView() {
  const data = useMemo(() => {
    const traces = getSampleTracesBrowser();
    const { rows } = extractPersonPeriodRows(traces);
    const results = computeAblationTable(traces);
    const full = results[results.length - 1];
    const traceInspired = evaluateTraceInspired(traces);
    const trajadInspired = evaluateTrajadInspired(traces);
    return { traces, rows, results, full, traceInspired, trajadInspired };
  }, []);

  const { traces, rows, results, full, traceInspired, trajadInspired } = data;
  const separationWarning = Math.max(...full.fit.beta.map(Math.abs)) > 8.0;

  const chartData = [
    ...results.map((r) => ({ name: r.model_name, auroc: Number(r.auroc.toFixed(3)) })),
    { name: 'TRACE-inspired', auroc: Number(traceInspired.auroc.toFixed(3)) },
    { name: 'TrajAD-inspired', auroc: Number(trajadInspired.auroc.toFixed(3)) },
  ];

  const z = full.fit.zScores();
  const pv = full.fit.pValues();

  return (
    <div>
      <div className="view-header">
        <div className="view-eyebrow">01 · Benchmark</div>
        <h1 className="view-title">Hazard model fit &amp; ablation matrix</h1>
        <p className="view-description">
          A ridge-penalized Newton-Raphson logistic regression fit live, in your browser, on the bundled{' '}
          <code className="inline">swe_bench_verified_fixtures.json</code> dataset. This is the same
          engine and the same math as <code className="inline">python/verigraph.py</code> and{' '}
          <code className="inline">cli/verigraph.ts</code> -- open devtools and re-run it, nothing is
          cached from a server.
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-cell-label">Traces</div>
          <div className="stat-cell-value tabular">{traces.length}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-cell-label">Person-period rows</div>
          <div className="stat-cell-value tabular">{rows.length}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-cell-label">Pseudo-R&sup2;</div>
          <div className="stat-cell-value tabular">{full.fit.pseudoR2.toFixed(3)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-cell-label">AIC</div>
          <div className="stat-cell-value tabular">{full.fit.aic.toFixed(1)}</div>
        </div>
      </div>

      {separationWarning && (
        <div className="warning-banner">
          <strong>Coefficient magnitudes are large</strong> -- usually a sign of (quasi-)complete
          separation. With only {traces.length} independent traces behind {rows.length}{' '}
          pseudo-replicated person-period rows and up to 9 parameters, treat these estimates as
          unstable, not as precise effect sizes.
        </div>
      )}

      <div className="panel">
        <h2 className="panel-title">Fitted coefficients (full model)</h2>
        <p className="panel-subtitle">Z-scored features. Computed by Newton-Raphson/IRLS, not hardcoded.</p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>&beta;</th>
              <th>SE</th>
              <th>z</th>
              <th>p</th>
              <th>Odds ratio</th>
            </tr>
          </thead>
          <tbody>
            {full.fit.names.map((name, i) => (
              <tr key={name}>
                <td className="label">{name}</td>
                <td className={full.fit.beta[i] >= 0 ? '' : ''}>{full.fit.beta[i] >= 0 ? '+' : ''}{full.fit.beta[i].toFixed(3)}</td>
                <td>{full.fit.se[i].toFixed(3)}</td>
                <td>{z[i] >= 0 ? '+' : ''}{z[i].toFixed(2)}</td>
                <td>{pv[i] < 0.001 ? '<0.001' : pv[i].toFixed(4)}</td>
                <td>{Math.exp(full.fit.beta[i]).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 className="panel-title">Ablation matrix -- AUROC by feature set</h2>
        <p className="panel-subtitle">
          Stock-only / Flow-only / Stock+Flow / Full model, plus the two inspired-by external
          baselines (amber).
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 48 }}>
            <CartesianGrid stroke="#262d34" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: '#8b95a1', fontSize: 10 }}
              angle={-30}
              textAnchor="end"
              interval={0}
              height={70}
              stroke="#262d34"
            />
            <YAxis domain={[0, 1]} tick={{ fill: '#8b95a1', fontSize: 10 }} stroke="#262d34" />
            <Tooltip
              contentStyle={{ background: '#171c21', border: '1px solid #262d34', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: '#e7ecef' }}
            />
            <Bar dataKey="auroc" radius={[3, 3, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={BAR_COLORS[i] ?? '#57a6ff'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        <table className="data-table" style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>AUROC</th>
              <th>F1</th>
              <th>Lead time</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.model_name}>
                <td className="label">{r.model_name}</td>
                <td>{r.auroc.toFixed(3)}</td>
                <td>{r.f1_score.toFixed(3)}</td>
                <td>+{r.lead_time_gain_steps} steps</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 className="panel-title">Inspired-by external baselines</h2>
        <div className="disclosure">
          <strong>Neither row below is the published method.</strong> TRACE (arXiv:2606.07054) is
          an LLM-in-the-loop agent evaluated on SHADE-Arena, a different benchmark; TrajAD
          (arXiv:2602.06443) is a fine-tuned specialized verifier with no public checkpoint. Both
          are unavailable to run as-published in this browser. What's below are rule-based,
          non-LLM approximations of each paper's structural idea (see{' '}
          <code className="inline">src/lib/inspiredBaselines.ts</code>), run for real on this
          dataset with the real AUROC/F1 code above -- not comparable to either paper's reported
          numbers.
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>AUROC</th>
              <th>F1</th>
              <th>Verdict rule</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="label">TRACE-inspired</td>
              <td>{traceInspired.auroc.toFixed(3)}</td>
              <td>{traceInspired.f1_score.toFixed(3)}</td>
              <td className="label">max finding severity &ge; 4 (paper's own stated rule)</td>
            </tr>
            <tr>
              <td className="label">TrajAD-inspired</td>
              <td>{trajadInspired.auroc.toFixed(3)}</td>
              <td>{trajadInspired.f1_score.toFixed(3)}</td>
              <td className="label">any resolution.failed / escalated event</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
