/**
 * Real evaluator-perspective backend — the deterministic seam that consumes a session's
 * findings.json. The live tmux/Claude half (runPerspectiveSessions) is not unit-tested; this
 * grounds everything downstream of it: parse/validate, the file-backed grader plugged into
 * runPanel, and escalation when a session's output is missing or malformed (AC-PANEL-006).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { Issue, PR, type IssueContract } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { runPanel, PERSPECTIVES } from '../src/pipeline/panel.js';
import type { BuildArtifact } from '../src/domain/artifact.js';
import {
  parsePerspectiveFindings,
  fileBackedGrader,
  sessionBackedGrader,
  perspectivePrompt,
  findingsPath,
} from '../src/pipeline/execution/perspective-session.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };

const contract: IssueContract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [{ id: 'AC-1', severity: 'blocker', behavior: 'do X', verification: { method: 'unit_test', expected: ['x'] } }],
  redLines: [],
};

function tmpDir(name: string): string {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a findings.json for one perspective under evalRoot (simulating a session's output). */
function writeFindings(evalRoot: string, perspective: string, body: unknown): void {
  const p = findingsPath(evalRoot, perspective);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(body), 'utf8');
}

describe('parsePerspectiveFindings', () => {
  it('normalises a valid session output into a PerspectiveResult', () => {
    const r = parsePerspectiveFindings({ verdict: 'request_changes', score: 0.4, findings: [{ criterionId: 'C1', severity: 'major', observed: 'o', requiredFix: ['fix it'] }] });
    expect(r.verdict).toBe('request_changes');
    expect(r.overall).toBe(0.4);
    expect(r.findings[0]!.criterionId).toBe('C1');
    expect(r.findings[0]!.requiredFix).toEqual(['fix it']);
  });

  it('defaults the score from the verdict when omitted', () => {
    expect(parsePerspectiveFindings({ verdict: 'approve' }).overall).toBe(1);
    expect(parsePerspectiveFindings({ verdict: 'request_changes' }).overall).toBe(0.3);
  });

  it('throws on malformed output (missing verdict / bad severity)', () => {
    expect(() => parsePerspectiveFindings({ findings: [] })).toThrow();
    expect(() => parsePerspectiveFindings({ verdict: 'approve', findings: [{ criterionId: 'C', severity: 'nope' }] })).toThrow();
    expect(() => parsePerspectiveFindings('not an object')).toThrow();
  });
});

describe('fileBackedGrader', () => {
  it('reads a perspective findings.json into a PerspectiveResult', () => {
    const evalRoot = tmpDir('psg-file');
    writeFindings(evalRoot, 'security', { verdict: 'approve' });
    const grade = fileBackedGrader(evalRoot);
    expect(grade('security', contract, {} as never, CONFIG).verdict).toBe('approve');
  });

  it('throws when the file is missing or malformed (→ runPanel escalates)', () => {
    const evalRoot = tmpDir('psg-missing');
    const grade = fileBackedGrader(evalRoot);
    expect(() => grade('security', contract, {} as never, CONFIG)).toThrow(); // absent
    writeFindings(evalRoot, 'security', { bogus: true });
    expect(() => grade('security', contract, {} as never, CONFIG)).toThrow(); // malformed
  });
});

describe('perspectivePrompt', () => {
  it('briefs the lens, the criteria, and the findings.json contract; forbids editing', () => {
    const p = perspectivePrompt('security', contract, '.agentops/eval/security');
    expect(p).toContain('security lens');
    expect(p).toContain('AC-1');
    expect(p).toContain('.agentops/eval/security/findings.json');
    expect(p.toLowerCase()).toContain('read-only');
  });

  it('adds the accepted UI design contract without changing non-UI briefings', () => {
    const without = perspectivePrompt('ux', contract, '.agentops/eval/ux');
    expect(without).not.toContain('## UI Design Contract');
    const withDesign = perspectivePrompt('ux', contract, '.agentops/eval/ux', [], {
      candidateKey: 'ui', principles: ['Clear state feedback'],
      tokens: [{
        id: 'motion-progress', category: 'motion', value: '150ms', rationale: 'Visible feedback',
        sourceCriterionIds: ['AC-1'],
      }],
      components: [{
        id: 'primary-action', name: 'Primary action', purpose: 'Does X', states: ['idle', 'loading'],
        interactions: ['activate'], accessibility: ['announces loading'], sourceCriterionIds: ['AC-1'],
      }],
      criterionTraces: [{ criterionId: 'AC-1', designElementIds: ['motion-progress', 'primary-action'] }],
    });
    expect(withDesign).toContain('## UI Design Contract');
    expect(withDesign).toContain('motion-progress');
    expect(withDesign).toContain('without inventing new UI scope');
  });
});

// --- integration: the file-backed grader drives runPanel end to end ----------

function seedPanel(store: Store): { issueId: string; prId: string } {
  store.addIssue(Issue.parse({ id: 'ISSUE-1', type: 'harness', title: 't', area: 'harness', status: 'contract-drafted', contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  for (const s of ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress'] as const) store.setStatus('ISSUE-1', s);
  const pr = store.addPR(PR.parse({ id: 'PR-1', issueId: 'ISSUE-1', branch: 'b', generator: 'claude', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  return { issueId: 'ISSUE-1', prId: pr.id };
}

const goodArtifact: BuildArtifact = {
  branch: 'b', summary: 's', filesChanged: ['src/x.ts'], satisfied: { 'AC-1': true },
  buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true, hasTests: true,
  secretsLeaked: false, scopeViolations: [], quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 }, notes: [],
};

function storeAt(name: string): Store {
  return new Store(tmpDir(name));
}

describe('runPanel with the real session backend', () => {
  it('grades from six findings.json files (+ deterministic functionality) and aggregates', () => {
    const evalRoot = tmpDir('psg-panel');
    for (const p of PERSPECTIVES) if (!p.deterministic) writeFindings(evalRoot, p.key, { verdict: 'approve' });
    const store = storeAt('psg-panel-store');
    const { issueId, prId } = seedPanel(store);

    const res = runPanel(store, CONFIG, { issueId, prId, contract, artifact: goodArtifact, sampleIndex: 0, attempt: 1, agent: 'claude', featureArea: 'harness' }, { grader: sessionBackedGrader(evalRoot) });

    expect(res.verdict).toBe('approve');
    expect(store.runsForIssue(issueId)).toHaveLength(PERSPECTIVES.length); // 6 session + 1 deterministic
  });

  it('ISSUE-0009/AC-LINEAGE-002 a lineage attested in findings.json reaches the stored EvalRun for that perspective', () => {
    const evalRoot = tmpDir('psg-panel-lineage');
    for (const p of PERSPECTIVES) if (!p.deterministic && p.key !== 'codeQuality') writeFindings(evalRoot, p.key, { verdict: 'approve' });
    writeFindings(evalRoot, 'codeQuality', {
      verdict: 'request_changes',
      findings: [
        { criterionId: 'AC-1', severity: 'major', observed: 'still duplicated', expected: 'deduplicated', lineage: 'persisted' },
        { criterionId: 'AC-1', severity: 'minor', observed: 'unattested note', expected: 'e' }, // legacy: no lineage
      ],
    });
    const store = storeAt('psg-panel-lineage-store');
    const { issueId, prId } = seedPanel(store);

    runPanel(store, CONFIG, { issueId, prId, contract, artifact: goodArtifact, sampleIndex: 0, attempt: 2, agent: 'claude', featureArea: 'harness' }, { grader: sessionBackedGrader(evalRoot) });

    const run = store.runsForIssue(issueId).find((r) => r.perspective === 'codeQuality')!;
    expect(run.findings.map((f) => f.lineage)).toEqual(['persisted', undefined]); // attested stored; absence stays absent
  });

  it('escalates when one perspective session left no (or broken) output', () => {
    const evalRoot = tmpDir('psg-panel-miss');
    for (const p of PERSPECTIVES) if (!p.deterministic && p.key !== 'security') writeFindings(evalRoot, p.key, { verdict: 'approve' });
    // security has no findings.json → grader throws → escalation
    const store = storeAt('psg-panel-miss-store');
    const { issueId, prId } = seedPanel(store);

    const res = runPanel(store, CONFIG, { issueId, prId, contract, artifact: goodArtifact, sampleIndex: 0, attempt: 1, agent: 'claude', featureArea: 'harness' }, { grader: sessionBackedGrader(evalRoot), maxGraderRetries: 0 });

    expect(res.escalated).toBe(true);
    expect(res.verdict).toBe('needs_human');
    expect(store.getIssue(issueId)!.status).toBe('needs-human-review');
  });
});
