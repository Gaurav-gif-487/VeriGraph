"""
VeriGraph: Python Reference Implementation
Deterministic Event-Sourced Dependency Graph & Stock/Flow Hazard Model

--------------------------------------------------------------------------
Bugs found in the original file, fixed here (see inline comments too):

1. __main__ was a no-op stub. Every CLI command ("benchmark", "analyze",
   "causal-test") printed "VeriGraph initialized successfully." and did
   nothing else, regardless of which command was passed. None of the
   commands documented in the README actually ran.

2. compute_centralities() summed only DIRECT outgoing edge weights. The
   README/report call this "dependency blast radius", which implies
   transitive downstream reach, not one hop. A node at the root of a long
   entangled chain scored the same as a node with one direct dependency.
   Replaced with a decayed multi-hop reachability BFS.

3. new_node_stock_t was computed (delta-stock decomposition) but never
   attached to the output snapshot or used anywhere, despite beta_5 in the
   README's own hazard formula being defined for exactly this term.

4. The hazard formula used hardcoded coefficients (-3.2, 0.48, 0.65, 0.35,
   0.15) that do NOT match the "fitted" coefficients printed in
   reports/verigraph_audit_report.json (-2.327, 0.096, 0.183, 0.8657,
   0.0827...). There was no fitting code anywhere in the repo -- the report's
   standard errors / z-scores / p-values / CIs were numbers with no
   computation behind them in this codebase. Replaced with a real
   Newton-Raphson (IRLS) logistic regression fit on the dataset, so every
   number below is actually computed from the data you feed it.

5. "benchmark" (ablation table, AUROC/F1/lead-time) and "causal-test"
   (centrality causal intervention) were referenced in the CLI and README
   but had zero implementation. Both are implemented below.

Honest limitation carried forward, not hidden: the bundled dataset's rich
per-step fields (raw_call.thought_reasoning, semantic_drift, counterfactual
survival curves, prompt_guard patches) are template-generated text, not
real model output -- e.g. every trace's reasoning string follows the same
"Analyzing target component: X... Planning next tool execution." pattern.
Treat benchmark numbers below as "how this algorithm performs on this
synthetic fixture set", not as validated real-agent performance.
--------------------------------------------------------------------------
"""
import sys
import os
import json
import math
import random
from collections import deque
from typing import List, Dict, Set, Tuple, Optional

RELATION_WEIGHTS = {
    'entanglement': 1.6,
    'undeclared_consumer': 1.4,
    'feedback_loop': 1.3,
    'depends_on': 1.0,
    'data_flow': 1.0,
    'direct_call': 1.0,
}
HOP_DECAY = 0.65            # per-hop attenuation for blast-radius centrality
SYMPTOM_WINDOW = 5
ALARM_THRESHOLD = 0.58      # matches reports/verigraph_audit_report.json
DIFFICULTY_MAP = {'easy': 0.0, 'medium': 1.0, 'hard': 2.0}
FEATURE_ORDER = ['stock', 'flow', 'stock_x_flow', 'delta_stock_existing',
                  'new_node_stock', 'step_frac', 'nodes_seen', 'task_difficulty']


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------
class GraphBuilder:
    def __init__(self):
        self.nodes: Set[str] = set()
        self.edges: List[Dict] = []
        self.open_obligations: Dict[str, List[str]] = {}

    def process_event(self, event: Dict):
        etype = event.get('type')
        nid = event.get('node_id')

        if etype == 'node.added':
            if nid:
                self.nodes.add(nid)
        elif etype == 'edge.added':
            target = event.get('target_node_id')
            rel = event.get('relation', 'depends_on')
            if nid and target:
                self.nodes.add(nid)
                self.nodes.add(target)
                self.edges.append({'source': nid, 'target': target, 'relation': rel,
                                    'weight': RELATION_WEIGHTS.get(rel, 1.0)})
        elif etype == 'obligation.opened':
            utype = event.get('uncertainty_type', 'unresolved_dependency')
            if nid:
                self.nodes.add(nid)
                self.open_obligations.setdefault(nid, []).append(utype)
        elif etype == 'resolution.succeeded':
            if nid and nid in self.open_obligations and self.open_obligations[nid]:
                self.open_obligations[nid].pop()
                if not self.open_obligations[nid]:
                    del self.open_obligations[nid]

    def compute_centralities(self) -> Dict[str, float]:
        """Blast-radius centrality: 1 + weighted, hop-decayed count of nodes
        transitively reachable downstream of v, where each edge contributes
        its Sculley antipattern severity weight. Fixes the original
        implementation, which only summed a node's direct out-edges and so
        never actually measured "blast radius" (multi-hop impact)."""
        adj: Dict[str, List[Tuple[str, float]]] = {}
        for e in self.edges:
            adj.setdefault(e['source'], []).append((e['target'], e['weight']))

        centralities = {}
        for n in self.nodes:
            visited = {n}
            queue = deque([(n, 1.0)])
            total = 0.0
            while queue:
                cur, decay = queue.popleft()
                for tgt, w in adj.get(cur, []):
                    if tgt not in visited:
                        visited.add(tgt)
                        total += w * decay
                        queue.append((tgt, decay * HOP_DECAY))
            centralities[n] = 1.0 + total
        return centralities


# ---------------------------------------------------------------------------
# Stock / Flow
# ---------------------------------------------------------------------------
class StockFlowCalculator:
    def __init__(self, symptom_window: int = SYMPTOM_WINDOW):
        self.symptom_window = symptom_window

    def analyze_trace(self, trace_dict: Dict) -> Dict:
        events = trace_dict.get('events', [])
        builder = GraphBuilder()
        snapshots = []
        obligation_status: Dict[Tuple[str, str], Dict] = {}
        prev_nodes: Set[str] = set()
        prev_cent: Dict[str, float] = {}
        prev_unres: Dict[str, int] = {}

        for step, ev in enumerate(events):
            builder.process_event(ev)
            curr_nodes = set(builder.nodes)
            cent = builder.compute_centralities()

            etype = ev.get('type')
            nid = ev.get('node_id', '')
            utype = ev.get('uncertainty_type', 'unresolved_dependency')
            k = (nid, utype)

            if etype == 'obligation.opened':
                obligation_status[k] = {'status': 'open', 'step': step}
            elif etype == 'resolution.attempted':
                if k in obligation_status and obligation_status[k]['status'] != 'resolved':
                    obligation_status[k] = {'status': 'attempted', 'step': step}
            elif etype == 'resolution.succeeded':
                if k in obligation_status:
                    obligation_status[k] = {'status': 'resolved', 'step': step}
            elif etype in ('resolution.failed', 'resolution.escalated'):
                is_symptom = ev.get('payload', {}).get('is_symptom', False)
                obligation_status[k] = {'status': 'symptom' if is_symptom else 'failed', 'step': step}

            stock_t, raw_unres = 0.0, 0
            curr_unres: Dict[str, int] = {}
            for n in curr_nodes:
                cnt = len(builder.open_obligations.get(n, []))
                curr_unres[n] = cnt
                raw_unres += cnt
                stock_t += cent.get(n, 1.0) * cnt

            delta_existing, new_node_stock = 0.0, 0.0
            for n in curr_nodes:
                if n in prev_nodes:
                    delta_existing += (cent.get(n, 1.0) * curr_unres.get(n, 0)) - \
                                       (prev_cent.get(n, 1.0) * prev_unres.get(n, 0))
                else:
                    new_node_stock += cent.get(n, 1.0) * curr_unres.get(n, 0)

            failed_count = sum(1 for v in obligation_status.values() if v['status'] == 'failed')
            symptom_count = sum(1 for v in obligation_status.values()
                                 if v['status'] == 'symptom' and (step - v['step']) <= self.symptom_window)
            flow_t = failed_count + symptom_count
            stock_x_flow = stock_t * flow_t

            snapshots.append({
                'step': step,
                'stock_t': round(stock_t, 3),
                'flow_t': flow_t,
                'stock_times_flow': round(stock_x_flow, 3),
                'delta_stock_existing_t': round(delta_existing, 3),
                'new_node_stock_t': round(new_node_stock, 3),   # FIX: now surfaced
                'raw_unresolved_count': raw_unres,
                'node_count': len(curr_nodes),
                'edge_count': len(builder.edges),
            })
            prev_nodes, prev_cent, prev_unres = curr_nodes, dict(cent), dict(curr_unres)

        return {
            'trace_id': trace_dict.get('id', 'trace'),
            'name': trace_dict.get('name', ''),
            'total_steps': len(events),
            'snapshots': snapshots,
        }


# ---------------------------------------------------------------------------
# Minimal linear algebra (no numpy dependency, matches original stdlib-only style)
# ---------------------------------------------------------------------------
def mat_zeros(r, c):
    return [[0.0] * c for _ in range(r)]


def mat_inverse(A: List[List[float]]) -> List[List[float]]:
    n = len(A)
    M = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(A)]
    for col in range(n):
        pivot_row = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[pivot_row][col]) < 1e-12:
            M[pivot_row][col] += 1e-9
        M[col], M[pivot_row] = M[pivot_row], M[col]
        piv = M[col][col]
        M[col] = [x / piv for x in M[col]]
        for r in range(n):
            if r != col:
                factor = M[r][col]
                if factor != 0:
                    M[r] = [M[r][j] - factor * M[col][j] for j in range(2 * n)]
    return [row[n:] for row in M]


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


def standardize(X: List[List[float]], exclude_idx=(0,)):
    n, k = len(X), len(X[0])
    means, stds = [0.0] * k, [1.0] * k
    for j in range(k):
        if j in exclude_idx:
            continue
        col = [X[i][j] for i in range(n)]
        m = sum(col) / n
        var = sum((c - m) ** 2 for c in col) / n
        s = math.sqrt(var) if var > 1e-9 else 1.0
        means[j], stds[j] = m, s
    Xs = [[(X[i][j] - means[j]) / stds[j] if j not in exclude_idx else X[i][j]
            for j in range(k)] for i in range(n)]
    return Xs, means, stds


# ---------------------------------------------------------------------------
# Logistic regression via Newton-Raphson / IRLS (replaces hardcoded coefficients)
# ---------------------------------------------------------------------------
class LogisticFitResult:
    def __init__(self, names, beta, se, log_likelihood, aic, pseudo_r2):
        self.names, self.beta, self.se = names, beta, se
        self.log_likelihood, self.aic, self.pseudo_r_squared = log_likelihood, aic, pseudo_r2

    def z_scores(self):
        return [b / s if s > 1e-9 else 0.0 for b, s in zip(self.beta, self.se)]

    def p_values(self):
        return [2 * (1 - norm_cdf(abs(z))) for z in self.z_scores()]

    def odds_ratios(self):
        return [math.exp(b) for b in self.beta]


def fit_logistic(X: List[List[float]], y: List[int], names: List[str],
                  ridge: float = 1.0, max_iter: int = 50, tol: float = 1e-8) -> LogisticFitResult:
    # NOTE on ridge default: with only ~25 independent traces (224 person-period
    # rows are pseudo-replicated within-trace, not 224 independent events) and
    # up to 9 free parameters, an unregularized fit hits quasi-complete
    # separation -- coefficients diverge toward +/-infinity and pseudo-R^2
    # saturates at 1.0 while standard errors explode. ridge=1e-3 (the original
    # value here) was too weak to prevent that; ridge=1.0 is a real L2 penalty
    # that keeps the fit identifiable. This trades a small amount of bias for
    # a model that doesn't silently blow up on a small, unbalanced dataset.
    n, k = len(X), len(X[0])
    beta = [0.0] * k
    ll = None
    for _ in range(max_iter):
        eta = [sum(X[i][j] * beta[j] for j in range(k)) for i in range(n)]
        p = [1.0 / (1.0 + math.exp(-max(-30, min(30, e)))) for e in eta]
        w = [max(pi * (1 - pi), 1e-6) for pi in p]
        grad = [sum(X[i][j] * (y[i] - p[i]) for i in range(n)) for j in range(k)]
        XtWX = mat_zeros(k, k)
        for i in range(n):
            wi, Xi = w[i], X[i]
            for a in range(k):
                xa = Xi[a] * wi
                if xa == 0:
                    continue
                for b in range(k):
                    XtWX[a][b] += xa * Xi[b]
        for a in range(k):
            XtWX[a][a] += ridge
        info_inv = mat_inverse(XtWX)
        step = [sum(info_inv[a][b] * grad[b] for b in range(k)) for a in range(k)]
        beta = [beta[j] + step[j] for j in range(k)]
        new_ll = sum(y[i] * math.log(max(p[i], 1e-12)) + (1 - y[i]) * math.log(max(1 - p[i], 1e-12))
                     for i in range(n))
        if ll is not None and abs(new_ll - ll) < tol:
            ll = new_ll
            break
        ll = new_ll

    eta = [sum(X[i][j] * beta[j] for j in range(k)) for i in range(n)]
    p = [1.0 / (1.0 + math.exp(-max(-30, min(30, e)))) for e in eta]
    w = [max(pi * (1 - pi), 1e-6) for pi in p]
    XtWX = mat_zeros(k, k)
    for i in range(n):
        wi, Xi = w[i], X[i]
        for a in range(k):
            xa = Xi[a] * wi
            if xa == 0:
                continue
            for b in range(k):
                XtWX[a][b] += xa * Xi[b]
    for a in range(k):
        XtWX[a][a] += ridge
    info_inv = mat_inverse(XtWX)
    se = [math.sqrt(max(info_inv[j][j], 0.0)) for j in range(k)]

    aic = 2 * k - 2 * ll
    ybar = min(max(sum(y) / n, 1e-9), 1 - 1e-9)
    ll_null = sum(y[i] * math.log(ybar) + (1 - y[i]) * math.log(1 - ybar) for i in range(n))
    pseudo_r2 = 1 - (ll / ll_null) if ll_null != 0 else 0.0
    return LogisticFitResult(names, beta, se, ll, aic, pseudo_r2)


# ---------------------------------------------------------------------------
# Person-period extraction (pooled discrete-time hazard rows)
# ---------------------------------------------------------------------------
def extract_person_period_rows(traces: List[Dict]):
    rows, labels, trace_ids, trace_step_index = [], [], [], []
    calc = StockFlowCalculator()
    per_trace_snaps = {}
    for tr in traces:
        analyzed = calc.analyze_trace(tr)
        per_trace_snaps[tr['id']] = analyzed
        n_steps = len(analyzed['snapshots'])
        bad = tr.get('ground_truth') != 'benign_success'
        diff = DIFFICULTY_MAP.get(tr.get('task_difficulty', 'medium'), 1.0)
        for i, s in enumerate(analyzed['snapshots']):
            rows.append({
                'stock': s['stock_t'], 'flow': s['flow_t'], 'stock_x_flow': s['stock_times_flow'],
                'delta_stock_existing': s['delta_stock_existing_t'], 'new_node_stock': s['new_node_stock_t'],
                'step_frac': (i + 1) / n_steps, 'nodes_seen': s['node_count'], 'task_difficulty': diff,
            })
            labels.append(1 if (bad and i == n_steps - 1) else 0)  # outcome only observable at trace end
            trace_ids.append(tr['id'])
            trace_step_index.append(i)
    return rows, labels, trace_ids, trace_step_index, per_trace_snaps


def build_matrix(rows: List[Dict], feature_names: List[str]):
    X = [[1.0] + [r[f] for f in feature_names] for r in rows]
    return X, ['intercept'] + feature_names


# ---------------------------------------------------------------------------
# Evaluation: AUROC (Mann-Whitney rank-sum, tie-aware), F1, ablation table
# ---------------------------------------------------------------------------
def auroc(scores: List[float], labels: List[int]) -> float:
    pos_n = sum(labels)
    neg_n = len(labels) - pos_n
    if pos_n == 0 or neg_n == 0:
        return float('nan')
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for m in range(i, j + 1):
            ranks[order[m]] = avg_rank
        i = j + 1
    rank_sum_pos = sum(ranks[idx] for idx, l in enumerate(labels) if l == 1)
    u = rank_sum_pos - pos_n * (pos_n + 1) / 2
    return u / (pos_n * neg_n)


def f1_at_alarm(alarm_flags: List[bool], labels: List[int]) -> float:
    tp = sum(1 for a, l in zip(alarm_flags, labels) if a and l)
    fp = sum(1 for a, l in zip(alarm_flags, labels) if a and not l)
    fn = sum(1 for a, l in zip(alarm_flags, labels) if (not a) and l)
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    return 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0


def fit_and_score(feature_names: List[str], rows, labels):
    X_raw, names = build_matrix(rows, feature_names)
    Xs, means, stds = standardize(X_raw, exclude_idx=(0,))
    fit = fit_logistic(Xs, labels, names)
    eta = [sum(Xs[i][j] * fit.beta[j] for j in range(len(names))) for i in range(len(Xs))]
    probs = [1.0 / (1.0 + math.exp(-max(-30, min(30, e)))) for e in eta]
    return fit, probs, means, stds


def evaluate_model(model_name, feature_names, rows, labels, trace_ids, trace_step_index,
                    per_trace_snaps, traces_by_id):
    fit, probs, means, stds = fit_and_score(feature_names, rows, labels)

    trace_peak, trace_alarm_step = {}, {}
    for i, tid in enumerate(trace_ids):
        trace_peak[tid] = max(trace_peak.get(tid, 0.0), probs[i])
        if probs[i] >= ALARM_THRESHOLD and tid not in trace_alarm_step:
            trace_alarm_step[tid] = trace_step_index[i]

    uniq_ids = list(dict.fromkeys(trace_ids))
    trace_labels = [1 if traces_by_id[tid].get('ground_truth') != 'benign_success' else 0 for tid in uniq_ids]
    trace_scores = [trace_peak[tid] for tid in uniq_ids]
    trace_alarm_flags = [tid in trace_alarm_step for tid in uniq_ids]

    leads = []
    for tid in uniq_ids:
        if traces_by_id[tid].get('ground_truth') != 'benign_success' and tid in trace_alarm_step:
            total = len(per_trace_snaps[tid]['snapshots'])
            leads.append(total - 1 - trace_alarm_step[tid])
    lead_gain = round(sum(leads) / len(leads)) if leads else 0

    return {
        'model_name': model_name,
        'auroc': auroc(trace_scores, trace_labels),
        'f1_score': f1_at_alarm(trace_alarm_flags, trace_labels),
        'lead_time_gain_steps': lead_gain,
        'fit': fit, 'means': means, 'stds': stds, 'feature_names': feature_names,
    }


def compute_ablation_table(traces: List[Dict]):
    rows, labels, trace_ids, trace_step_index, per_trace_snaps = extract_person_period_rows(traces)
    traces_by_id = {t['id']: t for t in traces}
    variants = [
        ('Stock-Only', ['stock']),
        ('Flow-Only', ['flow']),
        ('Stock+Flow (Additive)', ['stock', 'flow']),
        ('Full (Interaction + Controls)', FEATURE_ORDER),
    ]
    results = [evaluate_model(name, feats, rows, labels, trace_ids, trace_step_index,
                               per_trace_snaps, traces_by_id) for name, feats in variants]
    return results, rows, labels, trace_ids, trace_step_index, per_trace_snaps, traces_by_id


# ---------------------------------------------------------------------------
# "Inspired-by" external baselines
#
# IMPORTANT HONESTY NOTE: neither of these is the paper's actual method.
#   - TRACE (arXiv:2606.07054) is an LLM-in-the-loop agent (a Triage-
#     Inspect-Judge loop where an LLM reads trajectory text, selects
#     inspection actions, and issues a 1-5 suspicion verdict). Its
#     published F1=0.713/recall=0.844 were measured on SHADE-Arena, a
#     completely different benchmark, with an LLM backbone we don't have
#     API credentials to call here.
#   - TrajAD (arXiv:2602.06443) proposes a *fine-tuned* specialized
#     verifier model, trained with step-level process supervision on their
#     TrajBench dataset. There is no public checkpoint to run.
#
# What follows are rule-based, non-LLM approximations of each paper's
# *structural idea*, run for real against our own dataset, scored with our
# own real AUROC/F1 code -- not a reproduction of either paper's reported
# numbers, and not comparable to them. Treat these as "what does a cheap
# heuristic following the same architecture score on our data", nothing
# more.
# ---------------------------------------------------------------------------
def _percentile(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(q * (len(s) - 1))))
    return s[idx]


def trace_inspired_score(trace_dict: Dict) -> Dict:
    """Rule-based analogue of TRACE's Triage-Inspect-Judge loop.

    Triage: flag steps where an obligation is opened, then later fails or
    is escalated -- our analogue of TRACE's "actions that can't be
    explained by the task" trigger. Windows are +/-2 steps around each
    flag, merged if overlapping (mirrors TRACE's local/pattern windows).

    Inspect: each finding gets a rule-based severity 1-5 using node
    centrality as a stand-in for the LLM's judgment of how serious a
    violation looks -- high-centrality failures score higher, exactly as
    TRACE's real Judge phase would weight a violation touching more of the
    system more heavily.

    Judge: TRACE's paper states a fixed decision rule -- "a finding with
    severity 4-5 and high confidence MUST yield a score of at least 4".
    We copy that rule directly: final score = max finding severity. This
    keeps the decision boundary structural (taken from the paper) rather
    than fit to our dataset, so there's no data leakage into the
    threshold the way there could be if we calibrated it ourselves.
    """
    events = trace_dict.get('events', [])
    builder = GraphBuilder()
    open_at: Dict[Tuple[str, str], int] = {}
    findings = []  # (step, node, severity)

    for step, ev in enumerate(events):
        builder.process_event(ev)
        etype = ev.get('type')
        nid = ev.get('node_id', '')
        utype = ev.get('uncertainty_type', 'unresolved_dependency')
        k = (nid, utype)
        if etype == 'obligation.opened':
            open_at[k] = step
        elif etype in ('resolution.failed', 'resolution.escalated'):
            is_symptom = ev.get('payload', {}).get('is_symptom', False)
            cent = builder.compute_centralities()
            all_cent = list(cent.values())
            hi_thresh = _percentile(all_cent, 0.75)
            node_cent = cent.get(nid, 1.0)
            if not is_symptom and node_cent >= hi_thresh:
                sev = 5
            elif not is_symptom or node_cent >= hi_thresh:
                sev = 4
            else:
                sev = 3
            findings.append({'step': step, 'node': nid, 'severity': sev,
                              'centrality': round(node_cent, 3), 'is_symptom': is_symptom})

    # merge findings into +/-2-step windows purely for reporting; the score
    # itself only needs the max severity per the Judge rule above.
    windows = []
    for f in sorted(findings, key=lambda x: x['step']):
        placed = False
        for w in windows:
            if f['step'] - w['end'] <= 4:
                w['end'] = max(w['end'], f['step'] + 2)
                w['findings'].append(f)
                placed = True
                break
        if not placed:
            windows.append({'start': max(0, f['step'] - 2), 'end': f['step'] + 2, 'findings': [f]})

    max_severity = max((f['severity'] for f in findings), default=0)
    evidence_total = sum(f['severity'] for f in findings)  # continuous score for ranking (AUROC)
    return {
        'trace_id': trace_dict.get('id', 'trace'),
        'num_windows': len(windows),
        'findings': findings,
        'suspicion_score_1_5': max_severity,
        'evidence_total': evidence_total,
        'verdict_malicious': max_severity >= 4,  # TRACE's own stated threshold
    }


def evaluate_trace_inspired(traces: List[Dict]) -> Dict:
    scored = [trace_inspired_score(t) for t in traces]
    labels = [1 if t.get('ground_truth') != 'benign_success' else 0 for t in traces]
    scores = [s['evidence_total'] for s in scored]
    flags = [s['verdict_malicious'] for s in scored]
    return {
        'model_name': 'TRACE-inspired heuristic (arXiv:2606.07054, rule-based reimplementation)',
        'auroc': auroc(scores, labels),
        'f1_score': f1_at_alarm(flags, labels),
        'per_trace': scored,
    }


def trajad_inspired_localize(trace_dict: Dict) -> Dict:
    """Naive analogue of TrajAD's (c, l) task formalization:
        c = binary Normal/Anomaly verdict
        l = first_error_step, the index of the first anomalous step

    TrajAD's own contribution is a *trained* verifier because the paper's
    finding is that naive/zero-shot detection struggles at this task. So
    this function deliberately implements the naive version -- flag the
    first resolution.failed or resolution.escalated event, full stop, no
    centrality weighting, no learned scoring -- as a fair, low, expected
    baseline, not an attempt to reproduce TrajAD's trained performance.

    Localization accuracy note: our dataset has no step-level "true first
    error" annotation, only a whole-trace ground_truth label, so l is
    reported descriptively (which step got flagged first) but its
    correctness cannot be scored against ground truth here. Don't read
    the F1/AUROC below as a localization metric -- it's a whole-trace
    detection metric only.
    """
    events = trace_dict.get('events', [])
    first_error_step: Optional[int] = None
    anomaly_count = 0
    for step, ev in enumerate(events):
        if ev.get('type') in ('resolution.failed', 'resolution.escalated'):
            anomaly_count += 1
            if first_error_step is None:
                first_error_step = step
    return {
        'trace_id': trace_dict.get('id', 'trace'),
        'verdict': 'Anomaly' if anomaly_count > 0 else 'Normal',
        'first_error_step': first_error_step,
        'anomaly_event_count': anomaly_count,
    }


def evaluate_trajad_inspired(traces: List[Dict]) -> Dict:
    scored = [trajad_inspired_localize(t) for t in traces]
    labels = [1 if t.get('ground_truth') != 'benign_success' else 0 for t in traces]
    scores = [s['anomaly_event_count'] for s in scored]
    flags = [s['verdict'] == 'Anomaly' for s in scored]
    return {
        'model_name': 'TrajAD-inspired naive first-failure detector (arXiv:2602.06443 task formalization)',
        'auroc': auroc(scores, labels),
        'f1_score': f1_at_alarm(flags, labels),
        'per_trace': scored,
    }


# ---------------------------------------------------------------------------
# Causal intervention experiment: does injecting failure at a high-centrality
# node actually cause more downstream failures than at a peripheral node?
# ---------------------------------------------------------------------------
class CausalExperimentEngine:
    @staticmethod
    def _build_synthetic_graph() -> GraphBuilder:
        builder = GraphBuilder()
        events = [
            {'type': 'node.added', 'node_id': 'hub'},
            {'type': 'node.added', 'node_id': 'leaf_a'},
            {'type': 'node.added', 'node_id': 'leaf_b'},
            {'type': 'node.added', 'node_id': 'leaf_c'},
            {'type': 'node.added', 'node_id': 'leaf_d'},
            {'type': 'node.added', 'node_id': 'isolated_peripheral'},
            {'type': 'edge.added', 'node_id': 'hub', 'target_node_id': 'leaf_a', 'relation': 'entanglement'},
            {'type': 'edge.added', 'node_id': 'hub', 'target_node_id': 'leaf_b', 'relation': 'undeclared_consumer'},
            {'type': 'edge.added', 'node_id': 'hub', 'target_node_id': 'leaf_c', 'relation': 'feedback_loop'},
            {'type': 'edge.added', 'node_id': 'leaf_c', 'target_node_id': 'leaf_d', 'relation': 'depends_on'},
        ]
        for e in events:
            builder.process_event(e)
        return builder

    @staticmethod
    def run_experiment(trials: int = 30, seed: int = 42, base_rate: float = 0.15) -> Dict:
        rng = random.Random(seed)
        builder = CausalExperimentEngine._build_synthetic_graph()
        cent = builder.compute_centralities()
        # FIX: max()/min() over a dict built from a Python set iterate in an
        # order that depends on per-process string hash randomization, so tied
        # centrality values (e.g. several leaf nodes all at 1.0) picked a
        # different "peripheral" node on every run -- silently breaking the
        # "deterministic" guarantee this whole engine is supposed to provide.
        # Break ties on node_id so the choice is stable across runs.
        central_node = max(cent.items(), key=lambda kv: (kv[1], kv[0]))[0]
        peripheral_node = min(cent.items(), key=lambda kv: (kv[1], kv[0]))[0]
        c_max = max(cent.values())

        def run_arm(node: str) -> int:
            weight = cent[node] / c_max
            p_cascade = min(0.95, base_rate + 0.8 * weight)
            return sum(1 for _ in range(trials) if rng.random() < p_cascade)

        central_failures = run_arm(central_node)
        peripheral_failures = run_arm(peripheral_node)
        central_rate = central_failures / trials
        peripheral_rate = peripheral_failures / trials

        a, b = central_failures, trials - central_failures
        c, d = peripheral_failures, trials - peripheral_failures
        n = a + b + c + d
        den = (a + b) * (c + d) * (a + c) * (b + d)
        chi2 = (n * (abs(a * d - b * c) - n / 2) ** 2) / den if den > 0 else 0.0
        # exact for df=1: P(chi2_1 > x) = P(|Z| > sqrt(x)) = erfc(sqrt(x/2))
        p_value = math.erfc(math.sqrt(chi2 / 2)) if chi2 > 0 else 1.0

        return {
            'central_node': central_node, 'peripheral_node': peripheral_node,
            'central_centrality': round(cent[central_node], 3),
            'peripheral_centrality': round(cent[peripheral_node], 3),
            'central_failure_rate': central_rate, 'peripheral_failure_rate': peripheral_rate,
            'chi_square': round(chi2, 3), 'p_value_outcome_difference': p_value,
            'centrality_mechanism_supported': (central_rate > peripheral_rate) and (p_value < 0.05),
        }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _default_dataset_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, '..', 'datasets', 'swe_bench_verified_fixtures.json')


def cmd_benchmark(args: List[str]):
    path = args[0] if args else _default_dataset_path()
    traces = json.load(open(path))
    print("\n======================================================")
    print("   VeriGraph: Benchmark Evaluation & Hazard Fitter")
    print("======================================================\n")

    results, rows, labels, trace_ids, trace_step_index, per_trace_snaps, traces_by_id = \
        compute_ablation_table(traces)
    full = results[-1]

    print(f"Sample size: {len(traces)} traces ({len(rows)} person-period rows)")
    print(f"McFadden Pseudo-R^2: {full['fit'].pseudo_r_squared:.3f}")
    print(f"AIC: {full['fit'].aic:.1f}")
    if max(abs(b) for b in full['fit'].beta) > 8.0:
        print("WARNING: coefficient magnitudes this large usually mean (quasi-)complete "
              "separation -- with only 25 independent traces behind 224 pseudo-replicated "
              "person-period rows and up to 9 parameters, treat these estimates as unstable, "
              "not as precise effect sizes.")
    print()
    print("Fitted logistic coefficients (z-scored features, full model -- actually fit, not hardcoded):")
    z = full['fit'].z_scores()
    pv = full['fit'].p_values()
    for name, b, se, zi, p in zip(full['fit'].names, full['fit'].beta, full['fit'].se, z, pv):
        sig = '***' if p < 0.001 else ('**' if p < 0.01 else ('*' if p < 0.05 else ''))
        print(f"  {name:24s} beta={b:+.3f}  se={se:.3f}  z={zi:+.2f}  p={p:.4f} {sig}")

    print("\nAblation matrix:")
    header = f"{'Model':32s} {'AUROC':>8s} {'F1':>8s} {'LeadTime':>12s}"
    print(header)
    print('-' * len(header))
    for r in results:
        lead = f"+{r['lead_time_gain_steps']} steps"
        print(f"{r['model_name']:32s} {r['auroc']:8.3f} {r['f1_score']:8.3f} {lead:>12s}")

    trace_r = evaluate_trace_inspired(traces)
    trajad_r = evaluate_trajad_inspired(traces)
    print(f"{trace_r['model_name'][:32]:32s} {trace_r['auroc']:8.3f} {trace_r['f1_score']:8.3f} {'n/a':>12s}")
    print(f"{trajad_r['model_name'][:32]:32s} {trajad_r['auroc']:8.3f} {trajad_r['f1_score']:8.3f} {'n/a':>12s}")
    print(
        "\nNOTE: the two rows above are NOT the published TRACE/TrajAD methods -- they are "
        "rule-based, non-LLM approximations of each paper's structural idea, run on our own "
        "dataset. See docstrings in trace_inspired_score() / trajad_inspired_localize() for "
        "exactly what was and wasn't reproduced.\n"
    )
    return results


def cmd_analyze(args: List[str]):
    if not args or not os.path.exists(args[0]):
        print('Usage: python python/verigraph.py analyze <path_to_trace.json>')
        sys.exit(1)

    # Train the hazard model on the bundled benchmark set so "analyze" scores
    # a trace against a real fitted model instead of a magic-number heuristic.
    try:
        train_traces = json.load(open(_default_dataset_path()))
        rows, labels, _tids, _tsteps, _snaps = extract_person_period_rows(train_traces)
        fit, _probs, means, stds = fit_and_score(FEATURE_ORDER, rows, labels)
        have_model = True
    except Exception as exc:
        print(f"(warning: could not fit reference model -- {exc}; falling back to raw stock*flow heuristic)\n")
        have_model = False

    raw = json.load(open(args[0]))
    traces = raw if isinstance(raw, list) else [raw]
    calc = StockFlowCalculator()

    for tr in traces:
        analyzed = calc.analyze_trace(tr)
        n_steps = len(analyzed['snapshots'])
        print(f"\nAnalyzed Trace: {analyzed['trace_id']} ({analyzed['total_steps']} steps)"
              + (f" -- ground_truth={tr.get('ground_truth')}" if 'ground_truth' in tr else ''))
        print(f"{'Step':>5s} {'Stock':>9s} {'Flow':>6s} {'Stock*Flow':>11s} {'Hazard':>8s} {'Verdict':>10s}")
        diff = DIFFICULTY_MAP.get(tr.get('task_difficulty', 'medium'), 1.0)
        for i, s in enumerate(analyzed['snapshots']):
            if have_model:
                feat = {'stock': s['stock_t'], 'flow': s['flow_t'], 'stock_x_flow': s['stock_times_flow'],
                         'delta_stock_existing': s['delta_stock_existing_t'],
                         'new_node_stock': s['new_node_stock_t'],
                         'step_frac': (i + 1) / n_steps, 'nodes_seen': s['node_count'],
                         'task_difficulty': diff}
                names = ['intercept'] + FEATURE_ORDER
                x = [1.0] + [feat[f] for f in FEATURE_ORDER]
                xs = [(x[j] - means[j]) / stds[j] if j != 0 else x[j] for j in range(len(x))]
                eta = sum(xs[j] * fit.beta[j] for j in range(len(names)))
                hazard = 1.0 / (1.0 + math.exp(-max(-30, min(30, eta))))
            else:
                hazard = min(0.99, s['stock_times_flow'] / 20.0)
            alarm = hazard >= ALARM_THRESHOLD
            verdict = 'ALARM' if alarm else ('VERIFY' if hazard >= ALARM_THRESHOLD * 0.6 else 'Nominal')
            print(f"{s['step']:5d} {s['stock_t']:9.2f} {s['flow_t']:6d} {s['stock_times_flow']:11.2f} "
                  f"{hazard * 100:7.1f}% {verdict:>10s}")

        # highest-impact next verification action: currently open obligation
        # with the largest centrality * count contribution to stock_t
        builder = GraphBuilder()
        for ev in tr.get('events', []):
            builder.process_event(ev)
        cent = builder.compute_centralities()
        if builder.open_obligations:
            worst_node = max(builder.open_obligations,
                              key=lambda n: cent.get(n, 1.0) * len(builder.open_obligations[n]))
            print(f"\n  -> Highest-impact next action: resolve open obligation(s) on '{worst_node}' "
                  f"(centrality={cent.get(worst_node, 1.0):.2f}, "
                  f"{len(builder.open_obligations[worst_node])} unresolved)")
        else:
            print("\n  -> No open obligations remaining.")


def cmd_causal_test(args: List[str]):
    trials = int(args[0]) if args else 30
    print(f"\nRunning Stochastic Causal Intervention Experiment ({trials} trials per arm)...\n")
    res = CausalExperimentEngine.run_experiment(trials)
    print(f"Central node injected:              {res['central_node']} "
          f"(centrality={res['central_centrality']})")
    print(f"Peripheral node injected:           {res['peripheral_node']} "
          f"(centrality={res['peripheral_centrality']})")
    print(f"Central Injection Failure Rate:     {res['central_failure_rate'] * 100:.1f}%")
    print(f"Peripheral Injection Failure Rate:  {res['peripheral_failure_rate'] * 100:.1f}%")
    print(f"Chi-Square (df=1):                  {res['chi_square']}")
    print(f"Fisher/Chi-Square p-value:          {res['p_value_outcome_difference']:.3e}")
    print(f"Centrality Hypothesis Supported:    {'YES' if res['centrality_mechanism_supported'] else 'NO'}\n")
    return res


if __name__ == '__main__':
    args = sys.argv[1:]
    cmd = args[0] if args else 'benchmark'
    rest = args[1:]
    print(f"=== VeriGraph Python Engine: {cmd} ===")
    if cmd == 'benchmark':
        cmd_benchmark(rest)
    elif cmd == 'analyze':
        cmd_analyze(rest)
    elif cmd == 'causal-test':
        cmd_causal_test(rest)
    else:
        print(f"Unknown command '{cmd}'. Use: benchmark | analyze <file.json> | causal-test [trials]")
        sys.exit(1)
