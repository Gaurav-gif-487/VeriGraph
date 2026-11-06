import { useState } from 'react';
import BenchmarkView from './views/BenchmarkView';
import AnalyzeView from './views/AnalyzeView';
import CausalTestView from './views/CausalTestView';

type ViewId = 'benchmark' | 'analyze' | 'causal';

const NAV: { id: ViewId; label: string; index: string }[] = [
  { id: 'benchmark', label: 'Benchmark', index: '01' },
  { id: 'analyze', label: 'Analyze Trace', index: '02' },
  { id: 'causal', label: 'Causal Test', index: '03' },
];

export default function App() {
  const [view, setView] = useState<ViewId>('benchmark');

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="app-brand-mark">
            <span className="app-brand-dot" />
            <span className="app-brand-title">VeriGraph</span>
          </div>
          <div className="app-brand-sub">Flight Recorder</div>
        </div>
        <nav className="app-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`app-nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
            >
              <span className="app-nav-index tabular">{item.index}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="app-footer-note">
          Every number on this page is computed in your browser, live, from the same engine as
          the CLI and MCP server. Nothing here is pre-rendered or hardcoded.
        </div>
      </aside>
      <main className="app-main">
        {view === 'benchmark' && <BenchmarkView />}
        {view === 'analyze' && <AnalyzeView />}
        {view === 'causal' && <CausalTestView />}
      </main>
    </div>
  );
}
