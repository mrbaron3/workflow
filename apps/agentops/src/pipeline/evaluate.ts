/**
 * The Evaluator step: grade a build, write evidence, persist a Scorecard (EvalRun).
 *
 * Crucially, a verdict is never a bare pass/fail — it ships with evidence (what was
 * expected, what was observed, how to reproduce, where the trace is). That evidence
 * tree under .harness/evidence/<run-id>/ is what makes a FAIL auditable later.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as YAML from 'yaml';
import { EvalRun, type Finding } from '../domain/schema.js';
import type { Issue, PR } from '../domain/schema.js';
import type { BuildArtifact } from '../domain/artifact.js';
import type { HarnessConfig } from '../config.js';
import { Store, nowISO } from '../store/store.js';
import { gradeBuild } from '../graders/index.js';
import { hashUnit } from '../util/hash.js';

export interface EvaluateOpts {
  issue: Issue;
  pr: PR;
  artifact: BuildArtifact;
  sampleIndex: number;
  attempt: number;
}

export function evaluate(store: Store, config: HarnessConfig, opts: EvaluateOpts): EvalRun {
  const { issue, pr, artifact, sampleIndex, attempt } = opts;
  if (!issue.contract) throw new Error(`Issue ${issue.id} has no contract to evaluate against.`);

  const grade = gradeBuild(issue.contract, artifact, config);
  const evalId = store.nextId('EVAL', 5);
  const dir = store.evidenceDir(evalId);
  const rel = store.evidenceRel(evalId);

  // Attach evidence pointers to findings (trace for all; a "screenshot" for UI checks).
  const playwrightAcIds = new Set(
    issue.contract.acceptanceCriteria
      .filter((a) => a.verification.method === 'playwright')
      .map((a) => a.id),
  );
  const findings: Finding[] = grade.findings.map((f) => ({
    ...f,
    evidence: {
      trace: 'trace.txt',
      ...(playwrightAcIds.has(f.criterionId) ? { screenshot: 'screenshot.svg' } : {}),
    },
  }));

  // --- write the evidence tree ---------------------------------------------
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify(artifact, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'transcript.md'), renderTranscript(issue, pr, artifact), 'utf8');
  fs.writeFileSync(path.join(dir, 'trace.txt'), renderTrace(issue, findings), 'utf8');
  if (findings.some((f) => f.evidence.screenshot)) {
    fs.writeFileSync(path.join(dir, 'screenshot.svg'), renderScreenshot(issue, findings), 'utf8');
  }

  // --- cost (mock, deterministic) ------------------------------------------
  const c = hashUnit(`${evalId}|cost`);
  const tokens = Math.round(1500 + attempt * 600 + c * 1500);
  const cost = {
    tokens,
    usd: Number(((tokens / 1_000_000) * 3).toFixed(4)),
    seconds: Math.round(18 + attempt * 9 + c * 20),
  };

  const run = EvalRun.parse({
    id: evalId,
    issueId: issue.id,
    prId: pr.id,
    attempt,
    sampleIndex,
    agent: pr.generator,
    promptVersion: 'v0',
    graderVersion: 'v0',
    verdict: grade.verdict,
    hardGates: grade.hardGates,
    findings,
    scores: grade.scores,
    overall: grade.overall,
    evidenceDir: rel,
    cost,
    featureArea: issue.area,
    humanVerdict: null,
    createdAt: nowISO(),
  });
  store.addEvalRun(run);

  // The scorecard.yaml mirrors the run in the doc's human-readable format.
  fs.writeFileSync(path.join(dir, 'scorecard.yaml'), renderScorecard(run, issue), 'utf8');

  return run;
}

function renderScorecard(run: EvalRun, issue: Issue): string {
  return YAML.stringify({
    pr: run.prId,
    issue: run.issueId,
    eval_run_id: run.id,
    attempt: run.attempt,
    sample: run.sampleIndex,
    agent: run.agent,
    verdict: run.verdict,
    hard_gates: run.hardGates,
    blocking_findings: run.findings
      .filter((f) => f.severity === 'blocker')
      .map((f) => ({
        criterion_id: f.criterionId,
        severity: f.severity,
        expected: f.expected,
        observed: f.observed,
        reproduction_steps: f.reproductionSteps,
        evidence: f.evidence,
        required_fix: f.requiredFix,
      })),
    scores: run.scores,
    overall: Number(run.overall.toFixed(3)),
    next_action: run.verdict === 'approve' ? 'release' : 'return_to_generator',
  });
}

function renderTranscript(issue: Issue, pr: PR, artifact: BuildArtifact): string {
  return [
    `# Generator transcript — ${issue.id}`,
    ``,
    `PR: ${pr.id} (branch ${artifact.branch})`,
    `Summary: ${artifact.summary}`,
    ``,
    `## Files changed`,
    ...artifact.filesChanged.map((f) => `- ${f}`),
    ``,
    `## Notes`,
    ...artifact.notes.map((n) => `- ${n}`),
    ``,
  ].join('\n');
}

function renderTrace(issue: Issue, findings: Finding[]): string {
  const lines = [`TRACE for ${issue.id}`, `=`.repeat(40), ``];
  if (findings.length === 0) {
    lines.push('All checks passed. No failing steps recorded.');
  } else {
    for (const f of findings) {
      lines.push(`[FAIL] ${f.criterionId} (${f.severity})`);
      lines.push(`  expected: ${f.expected}`);
      lines.push(`  observed: ${f.observed}`);
      for (const s of f.reproductionSteps) lines.push(`  step: ${s}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderScreenshot(issue: Issue, findings: Finding[]): string {
  const first = findings.find((f) => f.evidence.screenshot);
  const caption = first ? first.observed : 'failure';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200">`,
    `  <rect width="640" height="200" fill="#1e1e2e"/>`,
    `  <text x="20" y="40" fill="#f38ba8" font-family="monospace" font-size="18">`,
    `    FAILED: ${escapeXml(issue.title)}`,
    `  </text>`,
    `  <text x="20" y="80" fill="#cdd6f4" font-family="monospace" font-size="14">`,
    `    ${escapeXml(caption)}`,
    `  </text>`,
    `  <text x="20" y="160" fill="#6c7086" font-family="monospace" font-size="12">`,
    `    (placeholder evidence screenshot — real runs capture a Playwright screenshot)`,
    `  </text>`,
    `</svg>`,
  ].join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c);
}
