/**
 * Metrics — the numbers the dashboard and retrospectives run on.
 *
 * The headline pair is pass@k vs pass^k (Anthropic's framing): pass@k measures
 * exploration ("did ANY of k samples pass") and trends UP with k; pass^k measures
 * consistency ("did ALL k pass") and trends DOWN with k. We report both, using the
 * unbiased estimators (Codex paper) so the curve is meaningful even for small N.
 *
 * Definitions used here:
 *   - a *sample* = one independent best-of-N attempt-from-scratch (with its own repair loop)
 *   - a sample "passes (eventual)" if it reached an approve verdict within maxRepairs
 *   - "pass@1 (first attempt)" = approved on attempt 1, no repair needed
 */

import type { EvalRun, Issue } from '../domain/schema.js';
import type { Store } from '../store/store.js';
import { aggregatePanelVerdict } from '../pipeline/panel.js';

export interface IssueStats {
  issueId: string;
  title: string;
  area: string;
  type: string;
  status: string;
  n: number; // samples
  passing: number; // eventually-passing samples
  firstAttemptPasses: number;
  maxAttempts: number;
  totalAttempts: number;
}

export interface AgentStats {
  agent: string;
  samples: number;
  passAt1: number;
  passEventual: number;
  avgAttempts: number;
  costUsd: number;
}

export interface Heatmap {
  areas: string[];
  types: string[];
  counts: Record<string, Record<string, number>>;
  max: number;
}

export interface Metrics {
  totals: {
    epics: number;
    issues: number;
    issuesRun: number;
    released: number;
    samples: number;
    evalRuns: number;
  };
  passAt1: number;
  passAtK: number;
  passHatK: number;
  headlineK: number;
  repairSuccessRate: number;
  prPassRate: number;
  avgRepairAttempts: number;
  instabilityRate: number; // fraction of run issues whose samples disagree
  cost: { usd: number; tokens: number; seconds: number };
  falsePassRate: number | null;
  falseFailRate: number | null;
  graderAgreement: number | null;
  passCurve: { k: number; passAtK: number; passHatK: number }[];
  byAgent: AgentStats[];
  heatmap: Heatmap;
  issues: IssueStats[];
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** Unbiased pass@k: probability that k random draws include >=1 success. */
function passAtKEstimator(n: number, c: number, k: number): number {
  if (k > n) return NaN;
  if (n - c < k) return 1;
  return 1 - comb(n - c, k) / comb(n, k);
}

/** pass^k: probability that k random draws are ALL successes. */
function passHatKEstimator(n: number, c: number, k: number): number {
  if (k > n) return NaN;
  if (c < k) return 0;
  return comb(c, k) / comb(n, k);
}

interface PerSample {
  sampleIndex: number;
  eventuallyPassed: boolean;
  firstApproved: boolean;
  attempts: number;
  agent: string;
}

function perSample(runs: EvalRun[]): PerSample[] {
  const bySample = new Map<number, EvalRun[]>();
  for (const r of runs) {
    const arr = bySample.get(r.sampleIndex) ?? [];
    arr.push(r);
    bySample.set(r.sampleIndex, arr);
  }
  const out: PerSample[] = [];
  for (const [sampleIndex, sruns] of bySample) {
    // AC-PANEL-009: a panel produces one EvalRun PER PERSPECTIVE for each attempt. Collapse
    // them into one aggregate verdict per attempt (DOM-execution-004) before counting, so the
    // sample/attempt denominators never scale with the perspective count. Legacy single
    // (perspective=null) runs aggregate to their own verdict — identical to the old behaviour.
    const byAttempt = new Map<number, EvalRun[]>();
    for (const r of sruns) {
      const arr = byAttempt.get(r.attempt) ?? [];
      arr.push(r);
      byAttempt.set(r.attempt, arr);
    }
    const attemptVerdict = (n: number): string => aggregatePanelVerdict(byAttempt.get(n) ?? []);
    out.push({
      sampleIndex,
      eventuallyPassed: [...byAttempt.keys()].some((n) => attemptVerdict(n) === 'approve'),
      firstApproved: byAttempt.has(1) && attemptVerdict(1) === 'approve',
      attempts: sruns.reduce((m, r) => Math.max(m, r.attempt), 0),
      agent: sruns[0]?.agent ?? 'mock',
    });
  }
  return out.sort((a, b) => a.sampleIndex - b.sampleIndex);
}

export function computeMetrics(store: Store): Metrics {
  const { issues, epics, evalRuns } = store.db;
  const runIssues = issues.filter((i) => store.runsForIssue(i.id).length > 0);

  const issueStats: IssueStats[] = [];
  let totalSamples = 0;
  let totalFirstPasses = 0;
  let failedFirst = 0;
  let repaired = 0;
  let totalAttempts = 0;
  let instable = 0;
  let maxN = 0;

  // aggregate cost across all runs
  let usd = 0;
  let tokens = 0;
  let seconds = 0;
  for (const r of evalRuns) {
    usd += r.cost.usd;
    tokens += r.cost.tokens;
    seconds += r.cost.seconds;
  }

  // per-agent accumulators
  const agentAcc = new Map<
    string,
    { samples: number; first: number; eventual: number; attempts: number; usd: number }
  >();

  for (const issue of runIssues) {
    const runs = store.runsForIssue(issue.id);
    const samples = perSample(runs);
    const n = samples.length;
    const c = samples.filter((s) => s.eventuallyPassed).length;
    maxN = Math.max(maxN, n);
    totalSamples += n;
    if (c > 0 && c < n) instable++;

    for (const s of samples) {
      totalAttempts += s.attempts;
      if (s.firstApproved) totalFirstPasses++;
      if (!s.firstApproved) {
        failedFirst++;
        if (s.eventuallyPassed) repaired++;
      }
      const a = agentAcc.get(s.agent) ?? { samples: 0, first: 0, eventual: 0, attempts: 0, usd: 0 };
      a.samples++;
      if (s.firstApproved) a.first++;
      if (s.eventuallyPassed) a.eventual++;
      a.attempts += s.attempts;
      agentAcc.set(s.agent, a);
    }
    // attribute per-sample cost to agent
    for (const r of runs) {
      const a = agentAcc.get(r.agent);
      if (a) a.usd += r.cost.usd;
    }

    issueStats.push({
      issueId: issue.id,
      title: issue.title,
      area: issue.area,
      type: issue.type,
      status: issue.status,
      n,
      passing: c,
      firstAttemptPasses: samples.filter((s) => s.firstApproved).length,
      maxAttempts: samples.reduce((m, s) => Math.max(m, s.attempts), 0),
      totalAttempts: samples.reduce((m, s) => m + s.attempts, 0),
    });
  }

  // pass curve averaged over issues (unbiased estimators)
  const headlineK = runIssues.length
    ? Math.min(...runIssues.map((i) => perSample(store.runsForIssue(i.id)).length))
    : 0;
  const passCurve: Metrics['passCurve'] = [];
  for (let k = 1; k <= maxN; k++) {
    const ats: number[] = [];
    const hats: number[] = [];
    for (const issue of runIssues) {
      const samples = perSample(store.runsForIssue(issue.id));
      const n = samples.length;
      const c = samples.filter((s) => s.eventuallyPassed).length;
      const at = passAtKEstimator(n, c, k);
      const hat = passHatKEstimator(n, c, k);
      if (!Number.isNaN(at)) ats.push(at);
      if (!Number.isNaN(hat)) hats.push(hat);
    }
    passCurve.push({
      k,
      passAtK: avg(ats),
      passHatK: avg(hats),
    });
  }
  const headline = passCurve.find((p) => p.k === headlineK);

  // false pass / fail from human labels, when present
  const labeled = evalRuns.filter((r) => r.humanVerdict !== null);
  let falsePassRate: number | null = null;
  let falseFailRate: number | null = null;
  let graderAgreement: number | null = null;
  if (labeled.length > 0) {
    const fp = labeled.filter(
      (r) => r.verdict === 'approve' && r.humanVerdict === 'request_changes',
    ).length;
    const ff = labeled.filter(
      (r) => r.verdict === 'request_changes' && r.humanVerdict === 'approve',
    ).length;
    const agree = labeled.filter((r) => r.verdict === r.humanVerdict).length;
    falsePassRate = fp / labeled.length;
    falseFailRate = ff / labeled.length;
    graderAgreement = agree / labeled.length;
  }

  return {
    totals: {
      epics: epics.length,
      issues: issues.length,
      issuesRun: runIssues.length,
      released: issues.filter((i) => i.status === 'released').length,
      samples: totalSamples,
      evalRuns: evalRuns.length,
    },
    passAt1: ratio(totalFirstPasses, totalSamples),
    passAtK: headline?.passAtK ?? 0,
    passHatK: headline?.passHatK ?? 0,
    headlineK,
    repairSuccessRate: ratio(repaired, failedFirst),
    prPassRate: ratio(
      issueStats.reduce((m, s) => m + s.passing, 0),
      totalSamples,
    ),
    avgRepairAttempts: ratio(totalAttempts, totalSamples),
    instabilityRate: ratio(instable, runIssues.length),
    cost: { usd: Number(usd.toFixed(4)), tokens, seconds },
    falsePassRate,
    falseFailRate,
    graderAgreement,
    passCurve,
    byAgent: [...agentAcc.entries()]
      .map(([agent, a]) => ({
        agent,
        samples: a.samples,
        passAt1: ratio(a.first, a.samples),
        passEventual: ratio(a.eventual, a.samples),
        avgAttempts: ratio(a.attempts, a.samples),
        costUsd: Number(a.usd.toFixed(4)),
      }))
      .sort((x, y) => y.samples - x.samples),
    heatmap: buildHeatmap(store, runIssues),
    issues: issueStats,
  };
}

function buildHeatmap(store: Store, runIssues: Issue[]): Heatmap {
  // map criterionId -> verification method, per issue
  const methodOf = new Map<string, string>();
  for (const issue of runIssues) {
    for (const ac of issue.contract?.acceptanceCriteria ?? []) {
      methodOf.set(`${issue.id}:${ac.id}`, ac.verification.method);
    }
  }
  const counts: Record<string, Record<string, number>> = {};
  const typeSet = new Set<string>();
  const areaSet = new Set<string>();
  let max = 0;
  for (const issue of runIssues) {
    for (const r of store.runsForIssue(issue.id)) {
      const area = r.featureArea;
      for (const f of r.findings) {
        if (f.severity !== 'blocker') continue;
        const type = f.criterionId.startsWith('GATE-')
          ? f.criterionId.slice(5)
          : methodOf.get(`${issue.id}:${f.criterionId}`) ?? 'criterion';
        areaSet.add(area);
        typeSet.add(type);
        counts[area] ??= {};
        const row = counts[area];
        row[type] = (row[type] ?? 0) + 1;
        max = Math.max(max, row[type]);
      }
    }
  }
  return {
    areas: [...areaSet].sort(),
    types: [...typeSet].sort(),
    counts,
    max,
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}
