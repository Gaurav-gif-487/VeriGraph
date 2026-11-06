import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContractGraph } from '../src/graph/ContractGraph.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import { calculateRiskPerImpact } from '../src/risk/PerImpactRisk.js';
import { ModuleGraph } from '../src/graph/TestCoverageResolver.js';
import type { ContractChange } from '../src/diff/GraphDiff.js';
import type { ContractNode, ContractEdge } from '../src/graph/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.join(__dirname, '..', 'fixtures', 'frontend', 'src');

function fixturePath(...parts: string[]) {
  return path.join(FRONTEND_ROOT, ...parts);
}

// -- hand-build a small graph over the REAL fixture consumer files -------
// (GraphBuilder itself needs the `typescript` npm package for AST parsing,
// which isn't installable offline in this environment -- see README. This
// constructs the same node/edge shapes GraphBuilder would produce, then
// runs everything downstream -- ImpactEngine.classify, RiskEngine, and the
// new calculateRiskPerImpact -- as the real, unmodified TypeScript source.)

function contractNode(id: string, name: string): ContractNode {
  return { id, type: 'contract', name, file: 'backend', metadata: { confidence: 100, evidence: [] } };
}

function consumerNode(id: string, name: string, file: string, accessedProperties: string[], isDynamicAccess = false): ContractNode {
  return {
    id, type: 'consumer', name, file,
    metadata: { confidence: 90, evidence: [], accessedProperties, isDynamicAccess },
  };
}

function consumesEdge(id: string, from: string, to: string): ContractEdge {
  return { id, from, to, relation: 'consumes', confidence: 90, evidence: [], resolutionMethod: 'exact' };
}

function buildGraph(): ContractGraph {
  const g = new ContractGraph();
  g.addNode(contractNode('contract:users', 'users'));
  g.addNode(contractNode('contract:settings', 'settings'));
  g.addNode(contractNode('contract:profile', 'profile'));

  g.addNode(consumerNode('consumer:userClient', 'userClient', fixturePath('api', 'userClient.ts'), ['email']));
  g.addNode(consumerNode('consumer:settingsClient', 'settingsClient', fixturePath('api', 'settingsClient.ts'), ['bio']));
  g.addNode(consumerNode('consumer:useProfile', 'useProfile', fixturePath('hooks', 'useProfile.ts'), ['verified']));

  g.addEdge(consumesEdge('e1', 'contract:users', 'consumer:userClient'));
  g.addEdge(consumesEdge('e2', 'contract:settings', 'consumer:settingsClient'));
  g.addEdge(consumesEdge('e3', 'contract:profile', 'consumer:useProfile'));
  return g;
}

function buildChanges(): ContractChange[] {
  return [
    { contractId: 'contract:users', kind: 'modified', nodeName: 'users', file: 'backend',
      fieldChanges: [{ path: 'root.email', kind: 'type-changed', before: 'string', after: 'number' }],
      renames: [], confidence: 100, evidence: [] },
    { contractId: 'contract:settings', kind: 'modified', nodeName: 'settings', file: 'backend',
      fieldChanges: [{ path: 'root.bio', kind: 'removed' }],
      renames: [], confidence: 100, evidence: [] },
    { contractId: 'contract:profile', kind: 'modified', nodeName: 'profile', file: 'backend',
      fieldChanges: [{ path: 'root.verified', kind: 'type-changed', before: 'boolean', after: 'string' }],
      renames: [], confidence: 100, evidence: [] },
  ];
}

test('TestCoverageResolver finds the seeded direct test on the real fixture repo', () => {
  const graph = new ModuleGraph(FRONTEND_ROOT);
  const tested = graph.has_coverage(fixturePath('api', 'userClient.ts'));
  assert.equal(tested.verdict, 'tested');

  const untested = graph.has_coverage(fixturePath('api', 'settingsClient.ts'));
  assert.equal(untested.verdict, 'untested');
});

test('calculateRiskPerImpact runs through the real, unmodified ImpactEngine + RiskEngine', () => {
  const graph = buildGraph();
  const changes = buildChanges();

  // real, unmodified engine call -- exercises actual classify() logic
  // (field-level matching, proof levels, etc.) and the actual aggregate
  // RiskEngine.calculateRisk internally.
  const report = ImpactEngine.evaluateImpact('base', 'current', changes, graph);

  assert.ok(report.risk.score >= 0, 'aggregate RiskEngine.calculateRisk still runs unmodified');
  assert.equal(report.impacts.length, 3);

  const perImpact = calculateRiskPerImpact(report.impacts, FRONTEND_ROOT);
  const byContract = Object.fromEntries(perImpact.map(r => [r.contract, r]));

  assert.equal(byContract['contract:users'].coverage, 'tested');
  assert.equal(byContract['contract:settings'].coverage, 'untested');

  // the untested alert must outrank the tested one -- this is the actual
  // per-alert differentiation the aggregate score can't produce.
  assert.ok(byContract['contract:settings'].rpn > byContract['contract:users'].rpn);

  // ranked output, highest RPN first
  assert.ok(perImpact[0].rpn >= perImpact[perImpact.length - 1].rpn);
});
