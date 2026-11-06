# VeriGraph: Runtime Verification Debt & Reliability Layer for AI Agents

## Overview
VeriGraph is a deterministic runtime observability layer for autonomous AI agent traces. It builds a typed dependency graph of claims, obligations, evidence, and unknowns from an agent's execution trace, computes a centrality-weighted unresolved verification debt stock ($stock_t$), combines it with deduplicated failure flow ($flow_t$) in a pooled discrete-time logistic hazard model, and returns a step-by-step verdict (`Nominal` / `VERIFY` / `ALARM`) plus the single highest-impact next verification action.

There are two independent, hand-ported implementations of the same algorithm: a Python reference engine and a TypeScript engine. Both are runnable and both are tested against the bundled fixture dataset in `datasets/swe_bench_verified_fixtures.json` (25 synthetic SWE-bench-derived traces).

## What's real right now
- **Graph construction & centrality** (`python/verigraph.py`, `src/lib/stockFlowEngine.ts`): event-sourced graph builder; centrality is a decayed multi-hop BFS ("blast radius"), not a one-hop out-degree sum.
- **Stock/flow computation**: `stock_t`, `flow_t`, `stock_t × flow_t`, and the stock delta decomposition (`delta_stock_existing_t`, `new_node_stock_t`) are computed per event-log step, not simulated.
- **Hazard model**: a real Newton-Raphson/IRLS logistic regression (ridge-penalized, L2=1.0) fit on person-period rows extracted from the dataset. Coefficients, standard errors, z-scores, p-values, odds ratios, and 95% CIs are all computed from the fit — none are hardcoded.
- **Ablation table**: Stock-only / Flow-only / Stock+Flow / Full model, each with AUROC (tie-aware Mann-Whitney), F1 at the alarm threshold, Brier score, and mean early-warning lead time, computed per variant.
- **Causal intervention experiment (v1, `causal-test`)**: injects synthetic failures at a high-centrality vs. low-centrality node on a small synthetic graph and reports the resulting chi-square test and p-value. Uses a deterministic seeded PRNG so results are reproducible. **Known flaw, not yet fixed in v1**: the per-node failure probability is `baseRate + 0.8 * (centrality / maxCentrality)` -- centrality is a direct input to the formula generating the outcome, so this test cannot return "hypothesis not supported." Kept in the repo for comparison against v2, not as a trustworthy result on its own.
- **Causal intervention experiment v2 (`causal-test-v2`, `src/lib/causalExperimentV2.ts`)**: same central-vs-peripheral injection idea, but centrality never enters the outcome-generating process. Outcomes come from a centrality-blind edge-propagation simulation (fixed probability per graph edge, plus independent background noise) over the *same* graph; centrality is computed separately and only compared against the result afterward. Verified falsifiable: sweeping the edge-propagation probability and PRNG seed produces "hypothesis not supported" in a majority of parameter settings tried (very low or very high propagation both wash out the central/peripheral difference toward a common floor/ceiling; only a middle range shows a reliable, significant gap). Still a synthetic graph, not a real agent trajectory -- see "known limitations" above for what that does and doesn't establish.
- **Causal intervention experiment v3 (`causal-test-v3`, `src/lib/causalExperimentV3.ts`)**: fixes a second, empirically-discovered issue -- v2 propagates outward from the injected node and ranks centrality by what a node calls (`computeCentralities`), which models a *corrupting* node contaminating its dependencies. A real mutation-testing pilot (see `real-experiment-toolkit`) showed ordinary defects propagate the other way -- a bug in a low-level function breaks its *callers* -- which is also the direction the stock/flow thesis is actually about (an unresolved obligation at X threatens whatever depends on X). v3 propagates against edge direction and ranks by the new `computeConsumerCentralities()`. Run repeatedly across 8+ seeds, it consistently shows the *opposite* of the hypothesis on this graph: the higher-consumer-centrality node is farther (2 hops) from the nearest critical root than the lower one (1 hop), so it needs `edgeProp^2` instead of `edgeProp^1` to get there -- a real structural finding that the blast-radius-SUM shape of centrality may be the wrong metric for "probability of reaching a specific critical node"; shortest-path distance might predict better. Documented in the file rather than silently fixed, since fixing it without real data to check against would just be swapping one unvalidated formula for another.
- **Test suite** (`tests/verigraph.test.ts` and related files, 18 tests, Node's built-in test runner): centrality math, obligation lifecycle, symptom-window flow decay, logistic fit sanity, AUROC/F1/Brier edge cases, causal-experiment determinism, and an end-to-end integration check against the real dataset.
- **`reports/verigraph_audit_report.json`** is generated by actually running the Python engine against the dataset (see `dataset_sha256` and the coefficients — they match a live `python python/verigraph.py benchmark` run). It is not hand-written.
- **"Inspired-by" external baselines** (`src/lib/inspiredBaselines.ts`, `trace_inspired_score()`/`trajad_inspired_localize()` in `python/verigraph.py`): rule-based, non-LLM approximations of TRACE (arXiv:2606.07054) and TrajAD (arXiv:2602.06443)'s structural ideas, run for real against our own dataset with our own AUROC/F1 code. See "External baselines: what's real and what isn't" below before reading any number from these rows.

## Known, stated limitations (not hidden)
- **Sample size is small.** 25 independent traces (224 pseudo-replicated person-period rows) with up to 9 parameters. The full model's near-perfect AUROC/F1 and large coefficient magnitudes mean the algorithm separates *this particular synthetic fixture set* cleanly — that is not the same as a validated real-world detection rate. The CLI prints this warning itself when it fires.
- **The fixture dataset is synthetic.** Its rich per-step narrative fields (reasoning text, etc.) are template-generated, not real model output. The graph events (nodes/edges/obligations) are used for real computation; the prose fields are not load-bearing for any number reported here.
- **The Python and TypeScript causal-test numbers will differ slightly.** They use independent seeded PRNGs (Python's `random.Random`, a JS `mulberry32`), not a shared RNG, so exact figures won't match between languages even though the algorithm is identical. The hazard-model and `analyze` output *does* match between languages, since that's deterministic given the same data.
- **Web workbench** (`src/app`, Vite + React, `npm run dev`): three views (Benchmark, Analyze, Causal Test) that run the exact same `src/lib` engine live in the browser -- no server round-trip, nothing pre-rendered. Verified with a headless Chromium render/interaction pass (zero console/page errors) before shipping.
- **MCP server** (`cli/verigraph-mcp.ts`, `npm run mcp`): a real `@modelcontextprotocol/sdk` server exposing `analyze_trace`, `run_benchmark`, `run_causal_test`, `list_sample_traces` over stdio, so Claude Desktop / Cursor / Windsurf / any MCP client can call the engine directly. Covered by an automated test that spawns the server as a subprocess and does a real JSON-RPC handshake (`tests/verigraph.test.ts`).
## External baselines: what's real and what isn't
Two rows in the ablation table (`TRACE-inspired heuristic` and `TrajAD-inspired naive first-failure detector`) reference real, verifiable papers — but are **not** those papers' actual methods, and their numbers are **not** comparable to the papers' published results:

- **TRACE (arXiv:2606.07054, "Trajectory Reasoning through Adaptive Cross-Step Evidence Aggregation")** is an LLM-in-the-loop agent: a Triage→Inspect→Judge loop where an LLM reads trajectory text, autonomously selects inspection actions, and issues a 1–5 suspicion verdict, averaging ~12 LLM calls per trajectory. Its published F1=0.713/recall=0.844 were measured on **SHADE-Arena** (463 sabotage trajectories across 10 task domains), a completely different benchmark than ours, using Claude Sonnet 4.6 as the backbone. This environment has no LLM API credentials wired up to run that loop, and even if it did, running it on *our* dataset instead of SHADE-Arena would still not reproduce their numbers.
- **TrajAD (arXiv:2602.06443, "Trajectory Anomaly Detection for Trustworthy LLM Agents")** formalizes the task as predicting `(c, l)` — a binary Normal/Anomaly verdict `c` and a first-error-step index `l` — then proposes a **fine-tuned specialized verifier** trained with step-level process supervision on their own TrajBench dataset. There's no public checkpoint to run, and the paper's own headline finding is that *general-purpose LLMs used zero-shot struggle at this task* — which is exactly why they needed to train a dedicated model.

What's actually implemented (`src/lib/inspiredBaselines.ts`, mirrored in `python/verigraph.py`):
- **TRACE-inspired**: flags obligations that fail or escalate, rates each with a rule-based severity 1–5 using node centrality as a stand-in for the LLM's judgment (higher centrality → higher severity), then applies TRACE's own stated Judge rule verbatim — *"a finding with severity 4–5 and high confidence MUST yield a score of at least 4"* — as `verdict_malicious = maxSeverity >= 4`. This threshold is copied from the paper's text, not fit on our data.
- **TrajAD-inspired**: deliberately the *naive* baseline TrajAD's paper argues against — flag the first `resolution.failed`/`resolution.escalated` event, no centrality weighting, no learned scoring. `first_error_step` is reported per trace but **not scored for correctness**, since our dataset has no step-level "true first error" annotation to check it against — only a whole-trace label.

Read the AUROC/F1 numbers for these two rows as "how does a cheap heuristic following the same architecture score on our own synthetic dataset," full stop — not as a benchmark result for either paper.

## Quickstart & CLI Commands

### TypeScript engine:
```bash
# 1. Install dependencies
npm install

# 2. Run benchmark evaluation & hazard model fit
npx tsx cli/verigraph.ts benchmark

# 3. Analyze any trace matching the event-log schema below
npx tsx cli/verigraph.ts analyze datasets/swe_bench_verified_fixtures.json

# 4. Run the causal intervention experiment
npx tsx cli/verigraph.ts causal-test 30
# NOTE: positional arg, not --trials 30 -- see "Honest limitations" below.

# v2: same idea, but centrality is no longer an input to the outcome-
# generating process, so the result can actually come out "not supported."
# See src/lib/causalExperimentV2.ts's header for why v1 could not.
npx tsx cli/verigraph.ts causal-test-v2 30

# v3: same as v2, but propagates against edge direction (callee -> caller)
# and ranks centrality by who depends on the node, not what it calls --
# see src/lib/causalExperimentV3.ts's header for why.
npx tsx cli/verigraph.ts causal-test-v3 30

# 5. Run the automated test suite (18 tests, incl. a real MCP protocol handshake)
npm test

# 6. Launch the interactive web workbench (Benchmark / Analyze / Causal Test, all live in-browser)
npm run dev
# -> open http://localhost:3000

# 7. Run the MCP server (stdio) -- point Claude Desktop / Cursor / Windsurf at this command
npm run mcp
```

The MCP server config for Claude Desktop (`claude_desktop_config.json`) looks like:
```json
{
  "mcpServers": {
    "verigraph": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/verigraph/cli/verigraph-mcp.ts"]
    }
  }
}
```
It exposes four tools: `analyze_trace`, `run_benchmark`, `run_causal_test`, `list_sample_traces` — see the tool descriptions in `cli/verigraph-mcp.ts` for exact schemas.

### Python reference engine:
```bash
# 1. Run benchmark & model fit
python python/verigraph.py benchmark

# 2. Analyze a trace
python python/verigraph.py analyze datasets/swe_bench_verified_fixtures.json

# 3. Run the causal intervention experiment
python python/verigraph.py causal-test 30
```

Both engines read the same event-log schema: a trace is `{id, name?, ground_truth?, task_difficulty?, events: [...]}` where each event has `type` (`node.added` / `edge.added` / `obligation.opened` / `resolution.attempted` / `resolution.succeeded` / `resolution.failed` / `resolution.escalated`), `node_id`, and, depending on type, `target_node_id`, `relation`, `uncertainty_type`, or `payload`.

---

## Core Mathematical Formulations

1. **Dynamic Verification Debt Stock**:
   $$stock_t = \sum_{v \in V_t} centrality_t(v) \times unresolved_t(v)$$
   $centrality_t(v)$ is a decayed multi-hop reachability sum (blast radius) over $G_t$, weighted by Sculley antipattern relation type:
   - CACE Entanglement: $\times 1.6$
   - Undeclared Consumers: $\times 1.4$
   - Feedback Loops: $\times 1.3$
   - Direct Dependencies: $\times 1.0$
   - Per-hop decay: $\times 0.65$

2. **Deduplicated Flow (4-state exhaustive partition)**:
   $$flow_t = |\{k : status_t(k) = \text{failed}\}| + |\{k : status_t(k) = \text{symptom}\}|$$
   Evaluated over deduplicated obligation keys $k = (node\_id, obligation\_type)$, with symptom window $W=5$.

3. **Pooled Discrete-Time Hazard Survival Model**:
   $$\text{logit } P(\text{final\_failure} \mid H_t) = \beta_0 + \beta_1 stock_t + \beta_2 flow_t + \beta_3 (stock_t \times flow_t) + \beta_4 \Delta\_stock\_existing_t + \beta_5 new\_node\_stock_t + \text{controls}$$
   Fit by ridge-penalized Newton-Raphson/IRLS on standardized features. See `reports/verigraph_audit_report.json` for the live fitted values.


## Causal-test versions

- `causal-test` (v1) is circular by construction: centrality feeds the simulated outcome, so the hypothesis cannot fail. Kept for reference.
- `causal-test-v2` computes outcomes from a centrality-blind contagion simulation and compares centrality afterwards. It is falsifiable: across propagation probabilities and seeds it often reports "not supported". On the default settings, central-node injection failed 93.3% of trials against 53.3% for a peripheral node (p = 1.3e-3).
- `causal-test-v3` propagates against edge direction (defects reach callers) and ranks by consumer centrality. On the synthetic graph it consistently shows the opposite of the hypothesis, because the node with the highest consumer centrality is two hops from the nearest critical node while the peripheral one is one hop away. Shortest-path distance may be a better predictor than summed reach.

All three run on a synthetic graph, not real agent traces.
