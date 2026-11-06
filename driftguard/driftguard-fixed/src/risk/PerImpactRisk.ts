import type { AffectedConsumerImpact } from '../impact/ImpactEngine.js';
import { ModuleGraph, type CoverageVerdict } from '../graph/TestCoverageResolver.js';

/**
 * RiskEngine.calculateRisk (see RiskEngine.ts) returns exactly one RiskReport
 * for the whole impacts array — no per-alert score. This is the per-impact
 * companion: same inputs, ranked per-consumer output, so "which of these N
 * alerts do I actually need to look at first" has an answer.
 *
 * calculateRisk itself is intentionally NOT modified — ImpactEngine still
 * calls it unchanged for the batch-level summary line.
 */

// Detectability gap weight: how much a missing/ambiguous test signal should
// inflate an alert's priority. cannot_determine gets its own weight rather
// than being folded into untested — the distinction has to stay visible to
// whoever's triaging (see design doc, "no confidence-tagging beyond these
// three verdicts").
const DETECT_GAP: Record<CoverageVerdict, number> = { tested: 1, untested: 10, cannot_determine: 5 };

export interface PerImpactRiskRow {
  contract: string;
  consumer: string;
  changedFields: number;
  confidence: number;
  severity: AffectedConsumerImpact['severity'];
  coverage: CoverageVerdict;
  detectGap: number;
  rpn: number;
}

export function calculateRiskPerImpact(
  impacts: readonly AffectedConsumerImpact[],
  workspaceRoot: string,
  maxIndirectHops = 2,
): PerImpactRiskRow[] {
  const graph = new ModuleGraph(workspaceRoot);
  const rows: PerImpactRiskRow[] = impacts.map(impact => {
    const { verdict } = graph.has_coverage(impact.consumerNode.file, maxIndirectHops);
    const gap = DETECT_GAP[verdict];
    const nFields = impact.changedPaths.length;
    return {
      contract: impact.targetContractId,
      consumer: impact.consumerNode.file,
      changedFields: nFields,
      confidence: impact.confidence,
      severity: impact.severity,
      coverage: verdict,
      detectGap: gap,
      rpn: Math.max(1, nFields) * impact.confidence * gap,
    };
  });
  rows.sort((a, b) => b.rpn - a.rpn);
  return rows;
}
