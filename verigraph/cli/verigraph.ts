// VeriGraph TypeScript Command Line Interface
// Every command below runs against the real engine in src/lib -- the
// previous version of this file imported six modules that did not exist
// anywhere in the repository, so no command here ever ran successfully.
import * as fs from 'fs';
import { getSampleTraces } from '../src/data/sampleDatasets';
import { extractPersonPeriodRows } from '../src/lib/logisticModel';
import { computeAblationTable } from '../src/lib/evaluation';
import { CausalExperimentEngine } from '../src/lib/causalExperiment';
import { CausalExperimentEngineV2 } from '../src/lib/causalExperimentV2';
import { CausalExperimentEngineV3 } from '../src/lib/causalExperimentV3';
import { RealTraceConverter, buildReferenceModel } from '../src/lib/realTraceConverter';
import { evaluateTraceInspired, evaluateTrajadInspired } from '../src/lib/inspiredBaselines';
import type { RawTrace } from '../src/lib/logisticModel';

const args = process.argv.slice(2);
const command = args[0] || 'benchmark';

function cmdBenchmark() {
  const traces = getSampleTraces(true);
  console.log('\n======================================================');
  console.log('   VeriGraph: Benchmark Evaluation & Hazard Fitter');
  console.log('======================================================\n');

  const { rows, labels } = extractPersonPeriodRows(traces);
  const results = computeAblationTable(traces);
  const full = results[results.length - 1];

  console.log(`Sample size: ${traces.length} traces (${rows.length} person-period rows)`);
  console.log(`McFadden Pseudo-R^2: ${full.fit.pseudoR2.toFixed(3)}`);
  console.log(`AIC: ${full.fit.aic.toFixed(1)}`);
  if (Math.max(...full.fit.beta.map(Math.abs)) > 8.0) {
    console.log(
      'WARNING: coefficient magnitudes this large usually mean (quasi-)complete separation -- ' +
        `with only ${traces.length} independent traces behind ${rows.length} pseudo-replicated ` +
        'person-period rows and up to 9 parameters, treat these estimates as unstable, not as ' +
        'precise effect sizes.'
    );
  }
  console.log();
  console.log('Fitted logistic coefficients (z-scored features, full model -- actually fit, not hardcoded):');
  const z = full.fit.zScores();
  const pv = full.fit.pValues();
  full.fit.names.forEach((name, i) => {
    const b = full.fit.beta[i];
    const se = full.fit.se[i];
    const p = pv[i];
    const sig = p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
    console.log(
      `  ${name.padEnd(24)} beta=${b >= 0 ? '+' : ''}${b.toFixed(3)}  se=${se.toFixed(3)}  ` +
        `z=${z[i] >= 0 ? '+' : ''}${z[i].toFixed(2)}  p=${p.toFixed(4)} ${sig}`
    );
  });

  console.log('\nAblation matrix:');
  const header = `${'Model'.padEnd(32)} ${'AUROC'.padStart(8)} ${'F1'.padStart(8)} ${'LeadTime'.padStart(12)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const lead = `+${r.lead_time_gain_steps} steps`;
    console.log(`${r.model_name.padEnd(32)} ${r.auroc.toFixed(3).padStart(8)} ${r.f1_score.toFixed(3).padStart(8)} ${lead.padStart(12)}`);
  }

  const traceR = evaluateTraceInspired(traces);
  const trajadR = evaluateTrajadInspired(traces);
  console.log(`${traceR.model_name.slice(0, 32).padEnd(32)} ${traceR.auroc.toFixed(3).padStart(8)} ${traceR.f1_score.toFixed(3).padStart(8)} ${'n/a'.padStart(12)}`);
  console.log(`${trajadR.model_name.slice(0, 32).padEnd(32)} ${trajadR.auroc.toFixed(3).padStart(8)} ${trajadR.f1_score.toFixed(3).padStart(8)} ${'n/a'.padStart(12)}`);
  console.log(
    '\nNOTE: the two rows above are NOT the published TRACE/TrajAD methods -- they are ' +
      "rule-based, non-LLM approximations of each paper's structural idea, run on our own " +
      'dataset. See src/lib/inspiredBaselines.ts for exactly what was and wasn\'t reproduced.\n'
  );
  return results;
}

function cmdAnalyze() {
  const filePath = args[1];
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Usage: npx tsx cli/verigraph.ts analyze <path_to_trace.json>');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const traces: RawTrace[] = Array.isArray(raw) ? raw : [raw];
  const referenceModel = buildReferenceModel(getSampleTraces(true));

  for (const tr of traces) {
    const analyzed = RealTraceConverter.parseGenericTrace(tr, referenceModel);
    console.log(
      `\nAnalyzed Trace: ${analyzed.trace_id} (${analyzed.total_steps} steps)` +
        (tr.ground_truth ? ` -- ground_truth=${tr.ground_truth}` : '')
    );
    console.log(`${'Step'.padStart(5)} ${'Stock'.padStart(9)} ${'Flow'.padStart(6)} ${'Stock*Flow'.padStart(11)} ${'Hazard'.padStart(8)} ${'Verdict'.padStart(10)}`);
    for (const s of analyzed.scored) {
      console.log(
        `${String(s.step).padStart(5)} ${s.stock_t.toFixed(2).padStart(9)} ${String(s.flow_t).padStart(6)} ` +
          `${s.stock_times_flow.toFixed(2).padStart(11)} ${(s.predicted_hazard_p * 100).toFixed(1).padStart(7)}% ${s.verdict.padStart(10)}`
      );
    }
    if (analyzed.highest_impact_action) {
      const a = analyzed.highest_impact_action;
      console.log(
        `\n  -> Highest-impact next action: resolve open obligation(s) on '${a.node}' ` +
          `(centrality=${a.centrality.toFixed(2)}, ${a.unresolved_count} unresolved)`
      );
    } else {
      console.log('\n  -> No open obligations remaining.');
    }
  }
}

function cmdCausalTest() {
  const trials = parseInt(args[1] || '30', 10);
  console.log(`\nRunning Stochastic Causal Intervention Experiment (${trials} trials per arm)...\n`);
  const res = CausalExperimentEngine.runExperiment(trials);
  console.log(`Central node injected:              ${res.central_node} (centrality=${res.central_centrality})`);
  console.log(`Peripheral node injected:           ${res.peripheral_node} (centrality=${res.peripheral_centrality})`);
  console.log(`Central Injection Failure Rate:     ${(res.central_failure_rate * 100).toFixed(1)}%`);
  console.log(`Peripheral Injection Failure Rate:  ${(res.peripheral_failure_rate * 100).toFixed(1)}%`);
  console.log(`Chi-Square (df=1):                  ${res.chi_square}`);
  console.log(`Fisher/Chi-Square p-value:          ${res.p_value_outcome_difference.toExponential(3)}`);
  console.log(`Centrality Hypothesis Supported:    ${res.centrality_mechanism_supported ? 'YES' : 'NO'}\n`);
  return res;
}

function cmdCausalTestV2() {
  const trials = parseInt(args[1] || '30', 10);
  console.log(
    `\nRunning Stochastic Causal Intervention Experiment v2 (${trials} trials per arm)...\n` +
      'Unlike v1, centrality is NOT an input to the failure-generating process --\n' +
      'outcomes come from a centrality-blind edge-propagation simulation. See\n' +
      "causalExperimentV2.ts's header for why v1 could never fail to confirm its own hypothesis.\n"
  );
  const res = CausalExperimentEngineV2.runExperiment(trials);
  console.log(`Central node injected:              ${res.central_node} (centrality=${res.central_centrality})`);
  console.log(`Peripheral node injected:            ${res.peripheral_node} (centrality=${res.peripheral_centrality})`);
  console.log(`Critical sink nodes:                 ${res.critical_sink_nodes.join(', ')}`);
  console.log(`Edge propagation probability (fixed, centrality-blind): ${res.edge_propagation_probability}`);
  console.log(`Background noise rate:               ${res.background_noise_rate}`);
  console.log(`Central Injection Failure Rate:      ${(res.central_failure_rate * 100).toFixed(1)}%`);
  console.log(`Peripheral Injection Failure Rate:   ${(res.peripheral_failure_rate * 100).toFixed(1)}%`);
  console.log(`Chi-Square (df=1):                   ${res.chi_square}`);
  console.log(`Fisher/Chi-Square p-value:           ${res.p_value_outcome_difference.toExponential(3)}`);
  console.log(`Centrality Hypothesis Supported:     ${res.centrality_mechanism_supported ? 'YES' : 'NO'}\n`);
  return res;
}

function cmdCausalTestV3() {
  const trials = parseInt(args[1] || '30', 10);
  console.log(
    `\nRunning Stochastic Causal Intervention Experiment v3 (${trials} trials per arm)...\n` +
      'v3 fixes a second issue (found empirically by real-experiment-toolkit, not guessed):\n' +
      'a defect propagates from a function to its CALLERS, not to what it calls. Central/\n' +
      "peripheral are now ranked by consumer-centrality, and propagation runs against edge\n" +
      "direction. See causalExperimentV3.ts's header.\n"
  );
  const res = CausalExperimentEngineV3.runExperiment(trials);
  console.log(`Central node injected (highest consumer-centrality):    ${res.central_node} (centrality=${res.central_centrality})`);
  console.log(`Peripheral node injected (lowest consumer-centrality):  ${res.peripheral_node} (centrality=${res.peripheral_centrality})`);
  console.log(`Critical root nodes (no callers -- top-level entrypoints): ${res.critical_sink_nodes.join(', ')}`);
  console.log(`Edge propagation probability (fixed, centrality-blind): ${res.edge_propagation_probability}`);
  console.log(`Background noise rate:               ${res.background_noise_rate}`);
  console.log(`Central Injection Failure Rate:      ${(res.central_failure_rate * 100).toFixed(1)}%`);
  console.log(`Peripheral Injection Failure Rate:   ${(res.peripheral_failure_rate * 100).toFixed(1)}%`);
  console.log(`Chi-Square (df=1):                   ${res.chi_square}`);
  console.log(`Fisher/Chi-Square p-value:           ${res.p_value_outcome_difference.toExponential(3)}`);
  console.log(`Centrality Hypothesis Supported:     ${res.centrality_mechanism_supported ? 'YES' : 'NO'}\n`);
  return res;
}

console.log(`=== VeriGraph TypeScript Engine: ${command} ===`);
if (command === 'benchmark') cmdBenchmark();
else if (command === 'analyze') cmdAnalyze();
else if (command === 'causal-test') cmdCausalTest();
else if (command === 'causal-test-v2') cmdCausalTestV2();
else if (command === 'causal-test-v3') cmdCausalTestV3();
else {
  console.error(`Unknown command '${command}'. Use: benchmark | analyze <file.json> | causal-test [trials] | causal-test-v2 [trials] | causal-test-v3 [trials]`);
  process.exit(1);
}
