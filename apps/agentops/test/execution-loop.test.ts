/**
 * Autonomous execution loop (drive + review gate) — grounds the 8 signed ACs of
 * docs/specs/execution-loop. Each `AC-LOOP-00N` names the criterion under test.
 * Uses the mock generator backend + deterministic panel graders — the whole loop
 * runs offline and deterministically.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { EvalRun, Issue, PR } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { driveOnce, driveIssueOnce, applyPanelVerdict, recordHumanDecision } from '../src/pipeline/execution/loop.js';
import { PERSPECTIVES, type PerspectiveGrader } from '../src/pipeline/panel.js';
import type { AgentRunner } from '../src/agents/runner.js';
import type { BuildArtifact } from '../src/domain/artifact.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1 };

/** A generator that returns a clean build (all hard gates pass) so the panel is convened. */
function cleanRunner(): AgentRunner {
  const artifact: BuildArtifact = {
    branch: 'agent/x', summary: 's', filesChanged: ['src/x.ts'], satisfied: { 'AC-1': true },
    buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true, hasTests: true,
    secretsLeaked: false, scopeViolations: [], quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 }, notes: [],
  };
  return { agent: 'mock', generate: async () => artifact };
}

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const contract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function addIssue(store: Store, id: string, opts: { aiManaged: boolean } = { aiManaged: true }): void {
  store.addIssue(
    Issue.parse({
      id,
      type: 'harness',
      title: id,
      area: 'harness',
      status: 'contract-drafted',
      assignedAgent: opts.aiManaged ? 'mock' : null, // ai-managed == assigned to the running backend
      contract,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

/** Force the panel to a chosen aggregate by making every perspective approve / reject. */
const allApprove: PerspectiveGrader = () => ({ verdict: 'approve', findings: [], scores: ones(), overall: 1 });
const oneRejects: PerspectiveGrader = (p) =>
  p === 'security'
    ? { verdict: 'request_changes', findings: [{ criterionId: 'SEC', severity: 'blocker', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['fix'] }], scores: zeros(), overall: 0 }
    : { verdict: 'approve', findings: [], scores: ones(), overall: 1 };

describe('AC-LOOP-001: ai-managed issue is driven to a verdict with no human HOW', () => {
  it('reaches build-approved (via the gate) and the status persists in the store', async () => {
    const store = tmpStore('loop-001');
    addIssue(store, 'ISSUE-1');
    const res = await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });

    expect(res).toHaveLength(1);
    // panel approve stops at the human gate — the terminal-for-now autonomous state
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
    // persisted: after a checkpoint (what watch does each turn), a fresh store sees the same place
    store.save();
    expect(new Store(store.root).getIssue('ISSUE-1')!.status).toBe('needs-human-review');
    expect(store.runsForIssue('ISSUE-1')).toHaveLength(PERSPECTIVES.length);
  });
});

describe('AC-LOOP-002: issues not opted in are never touched', () => {
  it('an unassigned issue is not polled and stays contract-drafted with no runs', async () => {
    const store = tmpStore('loop-002');
    addIssue(store, 'ISSUE-MINE', { aiManaged: true });
    addIssue(store, 'ISSUE-THEIRS', { aiManaged: false });
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });

    expect(store.getIssue('ISSUE-THEIRS')!.status).toBe('contract-drafted'); // untouched
    expect(store.runsForIssue('ISSUE-THEIRS')).toHaveLength(0);
    expect(store.getIssue('ISSUE-MINE')!.status).toBe('needs-human-review'); // mine was driven
  });
});

describe('AC-LOOP-003 / 004: resume + re-entry idempotency', () => {
  it('a second drive does not re-process an issue that already left the queue', async () => {
    const store = tmpStore('loop-003');
    addIssue(store, 'ISSUE-1');
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });
    const runsAfterFirst = store.runsForIssue('ISSUE-1').length;
    const prsAfterFirst = store.db.prs.length;

    // re-poll: ISSUE-1 is no longer contract-drafted, so nothing happens
    const second = await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });
    expect(second).toHaveLength(0);
    expect(store.runsForIssue('ISSUE-1').length).toBe(runsAfterFirst); // no new grading
    expect(store.db.prs.length).toBe(prsAfterFirst); // no new PR
  });

  it('an issue left at contract-drafted (never driven) is picked up on the next turn', async () => {
    const store = tmpStore('loop-004');
    addIssue(store, 'ISSUE-1');
    addIssue(store, 'ISSUE-2');
    // simulate a crash after ISSUE-1 only: drive one issue manually, leave ISSUE-2 pending
    await driveIssueOnce(store, CONFIG, cleanRunner(), store.getIssue('ISSUE-1')!, { panel: { grader: allApprove } });
    expect(store.getIssue('ISSUE-2')!.status).toBe('contract-drafted'); // still pending

    // resume: the next turn reconstructs the queue from store state and finishes ISSUE-2
    const resumed = await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });
    expect(resumed.map((r) => r.issueId)).toEqual(['ISSUE-2']);
    expect(store.getIssue('ISSUE-2')!.status).toBe('needs-human-review');
  });
});

describe('AC-LOOP-005: panel approve does not auto-release', () => {
  it('stops at needs-human-review, never released', async () => {
    const store = tmpStore('loop-005');
    addIssue(store, 'ISSUE-1');
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
    expect(store.getIssue('ISSUE-1')!.status).not.toBe('released');
  });
});

describe('AC-LOOP-006: human approval releases and is recorded as evidence', () => {
  it('release + humanVerdict=approve on the winning sample runs', async () => {
    const store = tmpStore('loop-006');
    addIssue(store, 'ISSUE-1');
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });

    const res = recordHumanDecision(store, 'ISSUE-1', 'approve');
    expect(store.getIssue('ISSUE-1')!.status).toBe('released');
    expect(res.labeledRunIds.length).toBe(PERSPECTIVES.length);
    for (const r of store.runsForIssue('ISSUE-1')) expect(r.humanVerdict).toBe('approve');
  });
});

describe('AC-LOOP-007: human rejection does not release and is recorded (false-pass calibration)', () => {
  it('stays unreleased and humanVerdict=request_changes is recorded', async () => {
    const store = tmpStore('loop-007');
    addIssue(store, 'ISSUE-1');
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });

    recordHumanDecision(store, 'ISSUE-1', 'reject');
    expect(store.getIssue('ISSUE-1')!.status).not.toBe('released');
    for (const r of store.runsForIssue('ISSUE-1')) expect(r.humanVerdict).toBe('request_changes');
  });
});

describe('current-head winning sample selection', () => {
  const currentRevisionId = 'PRREV-CURRENT';
  const currentHeadSha = 'a'.repeat(40);
  const oldRevisionId = 'PRREV-OLD';
  const oldHeadSha = 'b'.repeat(40);

  function seedBoundGate(store: Store, issueId: string): string {
    addIssue(store, issueId);
    for (const status of [
      'ready-for-generation',
      'generation-in-progress',
      'ready-for-evaluation',
      'evaluation-in-progress',
      'build-approved',
      'needs-human-review',
    ] as const) {
      store.setStatus(issueId, status);
    }
    return store.addPR(PR.parse({
      id: store.nextId('PR'),
      issueId,
      branch: `agent/${issueId.toLowerCase()}-s0`,
      baseBranch: 'main',
      generator: 'mock',
      attempts: 64,
      status: 'open',
      currentRevisionId,
      headSha: currentHeadSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).id;
  }

  function addPerspectiveRun(
    store: Store,
    input: {
      issueId: string;
      prId: string;
      attempt: number;
      perspective: string;
      revisionId: string;
      headSha: string;
      verdict?: 'approve' | 'request_changes';
    },
  ): EvalRun {
    return store.addEvalRun(EvalRun.parse({
      id: store.nextId('EVAL', 5),
      issueId: input.issueId,
      prId: input.prId,
      attempt: input.attempt,
      sampleIndex: 0,
      agent: 'mock',
      verdict: input.verdict ?? 'approve',
      scores: ones(),
      overall: 1,
      cost: {},
      perspective: input.perspective,
      revisionId: input.revisionId,
      headSha: input.headSha,
      createdAt: `2026-01-01T00:${String(input.attempt).padStart(2, '0')}:00.000Z`,
    }));
  }

  function addFullPanel(
    store: Store,
    input: {
      issueId: string;
      prId: string;
      attempt: number;
      revisionId: string;
      headSha: string;
      rejectingPerspective?: string;
    },
  ): EvalRun[] {
    return PERSPECTIVES.map(({ key }) => addPerspectiveRun(store, {
      ...input,
      perspective: key,
      verdict: key === input.rejectingPerspective ? 'request_changes' : 'approve',
    }));
  }

  it('labels only the complete approving panel for the PR current revision/head', () => {
    const store = tmpStore('loop-current-head');
    const issueId = 'ISSUE-CURRENT';
    const prId = seedBoundGate(store, issueId);
    const stalePartial = addPerspectiveRun(store, {
      issueId,
      prId,
      attempt: 24,
      perspective: 'functionality',
      revisionId: oldRevisionId,
      headSha: oldHeadSha,
    });
    const current = addFullPanel(store, {
      issueId,
      prId,
      attempt: 64,
      revisionId: currentRevisionId,
      headSha: currentHeadSha,
    });

    const result = recordHumanDecision(store, issueId, 'approve');

    expect(result.targetAttempt).toBe(64);
    expect(result.targetHeadSha).toBe(currentHeadSha);
    expect(result.labeledRunIds).toEqual(current.map((run) => run.id));
    expect(stalePartial.humanVerdict).toBeNull();
    expect(current.every((run) => run.humanVerdict === 'approve')).toBe(true);
  });

  it('rejects an incomplete current-head panel instead of falling back to an old approval', () => {
    const store = tmpStore('loop-current-incomplete');
    const issueId = 'ISSUE-INCOMPLETE';
    const prId = seedBoundGate(store, issueId);
    addFullPanel(store, {
      issueId,
      prId,
      attempt: 23,
      revisionId: oldRevisionId,
      headSha: oldHeadSha,
    });
    addPerspectiveRun(store, {
      issueId,
      prId,
      attempt: 24,
      perspective: 'functionality',
      revisionId: currentRevisionId,
      headSha: currentHeadSha,
    });

    expect(() => recordHumanDecision(store, issueId, 'approve'))
      .toThrow(/current PR head attempt 24 does not have the complete required panel/);
    expect(store.getIssue(issueId)?.status).toBe('needs-human-review');
    expect(store.runsForIssue(issueId).every((run) => run.humanVerdict === null)).toBe(true);
  });

  it('rejects a non-approving current-head panel instead of falling back to an old approval', () => {
    const store = tmpStore('loop-current-rejected');
    const issueId = 'ISSUE-REJECTED';
    const prId = seedBoundGate(store, issueId);
    addFullPanel(store, {
      issueId,
      prId,
      attempt: 23,
      revisionId: oldRevisionId,
      headSha: oldHeadSha,
    });
    addFullPanel(store, {
      issueId,
      prId,
      attempt: 24,
      revisionId: currentRevisionId,
      headSha: currentHeadSha,
      rejectingPerspective: 'security',
    });

    expect(() => recordHumanDecision(store, issueId, 'approve'))
      .toThrow(/current PR head panel is not approve/);
    expect(store.getIssue(issueId)?.status).toBe('needs-human-review');
    expect(store.runsForIssue(issueId).every((run) => run.humanVerdict === null)).toBe(true);
  });
});

describe('AC-LOOP-008: applying a human decision is idempotent', () => {
  it('a second approve does not re-release or double-record', async () => {
    const store = tmpStore('loop-008');
    addIssue(store, 'ISSUE-1');
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });

    const first = recordHumanDecision(store, 'ISSUE-1', 'approve');
    expect(first.changed).toBe(true);
    const second = recordHumanDecision(store, 'ISSUE-1', 'approve');
    expect(second.changed).toBe(false); // no-op on an already-released issue
    expect(store.getIssue('ISSUE-1')!.status).toBe('released');
  });
});

describe('gate routing (applyPanelVerdict)', () => {
  it('request_changes routes to changes-requested (not the gate)', () => {
    const store = tmpStore('loop-rc');
    addIssue(store, 'ISSUE-1');
    for (const s of ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress'] as const) store.setStatus('ISSUE-1', s);
    applyPanelVerdict(store, 'ISSUE-1', 'request_changes');
    expect(store.getIssue('ISSUE-1')!.status).toBe('changes-requested');
  });

  it('approve routes through build-approved to the human gate', () => {
    const store = tmpStore('loop-router');
    addIssue(store, 'ISSUE-1');
    for (const s of ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress'] as const) store.setStatus('ISSUE-1', s);
    applyPanelVerdict(store, 'ISSUE-1', 'approve');
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
  });

  it('a persistently-rejecting panel exhausts the repair loop and escalates (not the gate)', async () => {
    const store = tmpStore('loop-persist-reject');
    addIssue(store, 'ISSUE-1');
    const res = await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: oneRejects } });
    // never reached build-approved via approval; ended at human review after the bound
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
    expect(res[0]!.exhausted).toBe(true);
    expect(res[0]!.attempts).toBe(CONFIG.maxRepairs + 1);
  });
});

function zeros() {
  return { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 };
}
function ones() {
  return { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 };
}
