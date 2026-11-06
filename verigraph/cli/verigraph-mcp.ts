#!/usr/bin/env node
// VeriGraph MCP Server
//
// Exposes the real engine in src/lib as MCP tools over stdio, so Claude
// Desktop / Cursor / Windsurf / any MCP client can call it directly.
// Previously this file was referenced in package.json and README but did
// not exist at all -- `npm run mcp` failed outright. Everything below
// calls the same functions the CLI calls; there is no separate
// implementation to drift out of sync.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getSampleTraces } from '../src/data/sampleDatasets.js';
import { extractPersonPeriodRows } from '../src/lib/logisticModel.js';
import { computeAblationTable } from '../src/lib/evaluation.js';
import { CausalExperimentEngine } from '../src/lib/causalExperiment.js';
import { RealTraceConverter, buildReferenceModel } from '../src/lib/realTraceConverter.js';
import { evaluateTraceInspired, evaluateTrajadInspired } from '../src/lib/inspiredBaselines.js';
import type { RawTrace } from '../src/lib/logisticModel.js';

const server = new McpServer({
  name: 'verigraph',
  version: '0.2.0',
  title: 'VeriGraph Runtime Verification Debt Analyzer',
});

// ---------------------------------------------------------------------------
// analyze_trace: run the real hazard model on a user-supplied trace
// ---------------------------------------------------------------------------
server.registerTool(
  'analyze_trace',
  {
    title: 'Analyze an agent trace for verification debt',
    description:
      'Runs a single agent execution trace (event log) through the VeriGraph stock/flow engine and ' +
      'a pooled logistic hazard model fit on the bundled reference dataset. Returns a step-by-step ' +
      'hazard percentage, Nominal/VERIFY/ALARM verdict, and the single highest-impact next verification ' +
      'action (the node with the most centrality-weighted open obligations).',
    inputSchema: {
      trace: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          ground_truth: z.string().optional(),
          task_difficulty: z.string().optional(),
          events: z.array(z.record(z.string(), z.any())),
        })
        .describe(
          'Event log: {id?, name?, ground_truth?, task_difficulty?, events: [{type, node_id, target_node_id?, ' +
            'relation?, uncertainty_type?, payload?}, ...]}. Event types: node.added, edge.added, ' +
            'obligation.opened, resolution.attempted, resolution.succeeded, resolution.failed, resolution.escalated.'
        ),
    },
  },
  async ({ trace }) => {
    const referenceModel = buildReferenceModel(getSampleTraces(true) as RawTrace[]);
    const result = RealTraceConverter.parseGenericTrace(trace as RawTrace, referenceModel);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// run_benchmark: fit the hazard model on the bundled dataset, ablation table
// ---------------------------------------------------------------------------
server.registerTool(
  'run_benchmark',
  {
    title: 'Run the VeriGraph benchmark & hazard model fit',
    description:
      'Fits a ridge-penalized logistic hazard model on the bundled swe_bench_verified_fixtures.json dataset ' +
      '(25 synthetic traces, 224 person-period rows) and returns the fitted coefficients (with SE/z/p-values), ' +
      'the Stock-only/Flow-only/Stock+Flow/Full ablation table (AUROC, F1, lead time), and two clearly-labeled ' +
      'rule-based approximations of external papers (TRACE-inspired, TrajAD-inspired -- see their tool ' +
      'descriptions in src/lib/inspiredBaselines.ts for what was and was not reproduced). Every number is ' +
      'computed live, not cached.',
    inputSchema: {},
  },
  async () => {
    const traces = getSampleTraces(true);
    const { rows } = extractPersonPeriodRows(traces);
    const results = computeAblationTable(traces);
    const full = results[results.length - 1];
    const traceInspired = evaluateTraceInspired(traces);
    const trajadInspired = evaluateTrajadInspired(traces);

    const warning =
      Math.max(...full.fit.beta.map(Math.abs)) > 8.0
        ? `WARNING: coefficient magnitudes this large usually mean (quasi-)complete separation -- with only ` +
          `${traces.length} independent traces behind ${rows.length} pseudo-replicated person-period rows and ` +
          `up to 9 parameters, treat these estimates as unstable, not as precise effect sizes.`
        : null;

    const payload = {
      sample_size_traces: traces.length,
      sample_size_person_period_rows: rows.length,
      warning,
      full_model_fit: {
        names: full.fit.names,
        beta: full.fit.beta,
        standard_errors: full.fit.se,
        z_scores: full.fit.zScores(),
        p_values: full.fit.pValues(),
        pseudo_r_squared: full.fit.pseudoR2,
        aic: full.fit.aic,
      },
      ablation_table: results.map((r) => ({
        model_name: r.model_name,
        auroc: r.auroc,
        f1_score: r.f1_score,
        brier_score: r.brier_score,
        lead_time_gain_steps: r.lead_time_gain_steps,
      })),
      inspired_by_external_baselines: {
        disclosure:
          'Neither row below is the published TRACE/TrajAD method. Both are rule-based, non-LLM ' +
          'approximations run on our own dataset -- see src/lib/inspiredBaselines.ts for exactly what ' +
          'was substituted and why.',
        trace_inspired: { model_name: traceInspired.model_name, auroc: traceInspired.auroc, f1_score: traceInspired.f1_score },
        trajad_inspired: { model_name: trajadInspired.model_name, auroc: trajadInspired.auroc, f1_score: trajadInspired.f1_score },
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// run_causal_test: centrality causal intervention experiment
// ---------------------------------------------------------------------------
server.registerTool(
  'run_causal_test',
  {
    title: 'Run the centrality causal intervention experiment',
    description:
      'Injects synthetic failures at a high-centrality node vs. a low-centrality (peripheral) node on a small ' +
      'synthetic dependency graph, and reports whether the high-centrality node actually causes a higher ' +
      'downstream failure rate (chi-square test, deterministic seeded PRNG for reproducibility). This tests ' +
      "whether the engine's centrality weighting reflects a real causal mechanism, not just a correlation.",
    inputSchema: {
      trials: z.number().int().min(1).max(2000).default(30).describe('Trials per arm (central vs. peripheral).'),
      seed: z.number().int().default(42).describe('PRNG seed for reproducibility.'),
    },
  },
  async ({ trials, seed }) => {
    const result = CausalExperimentEngine.runExperiment(trials, seed);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// list_sample_traces: introspection helper so a client can browse the
// bundled dataset before calling analyze_trace on one of its entries
// ---------------------------------------------------------------------------
server.registerTool(
  'list_sample_traces',
  {
    title: 'List bundled sample traces',
    description:
      'Lists the id, name, ground_truth label, and step count of every trace in the bundled ' +
      'swe_bench_verified_fixtures.json dataset, so a client can pick one to inspect in detail with analyze_trace.',
    inputSchema: {},
  },
  async () => {
    const traces = getSampleTraces(true);
    const summary = traces.map((t) => ({
      id: t.id,
      name: t.name,
      ground_truth: t.ground_truth,
      task_difficulty: t.task_difficulty,
      num_events: t.events?.length ?? 0,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VeriGraph MCP server running on stdio.');
}

main().catch((err) => {
  console.error('VeriGraph MCP server failed to start:', err);
  process.exit(1);
});
