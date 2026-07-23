/**
 * Live repair — the two deterministic seams that let the live drive run the SAME bounded repair
 * loop as the mock drive (handoff "ライブ repair"):
 *   1. buildGeneratorPrompt carries the reviewers' required fixes into the generator's prompt on a
 *      repair attempt, and omits that section on the fresh first attempt.
 *   2. runBoundedRepairLoop (shared by driveIssueOnce and driveIssueLive) threads each attempt's
 *      cross-perspective findings into the next attempt's brief, and — the live-only branch the
 *      mock runner never hits — escalates a stuck generator to the human gate, session kept alive.
 * The live composition itself (real tmux + Claude) stays out of unit tests by design; here we test
 * the seams it plugs together.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, PR, Finding, type EvalRun } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig, type TargetRepoConfig } from '../src/config.js';
import { runBoundedRepairLoop, type AttemptOutcome } from '../src/pipeline/execution/loop.js';
import { buildGeneratorPrompt, type GeneratorSessionInput } from '../src/pipeline/execution/session.js';
import type { PanelResult } from '../src/pipeline/panel.js';
import type { RepairBrief } from '../src/domain/artifact.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1, maxRepairs: 2 }; // 3 attempts max

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: ['src/x.ts'], exclude: [] },
  acceptanceCriteria: [{ id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } }],
  redLines: [],
};

function addIssue(store: Store, id: string): Issue {
  return store.addIssue(
    Issue.parse({
      id, type: 'harness', title: id, area: 'harness', status: 'contract-drafted', assignedAgent: 'mock',
      contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

function addPR(store: Store, issueId: string): PR {
  return store.addPR(
    PR.parse({
      id: store.nextId('PR'), issueId, branch: `agent/${issueId.toLowerCase()}-s0`,
      baseBranch: CONFIG.baseBranch, generator: 'mock', attempts: 0, status: 'open',
      createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

/** A panel that rejects, carrying one blocker finding on the codeQuality lens (drives a real brief). */
function rejectingPanel(criterionId: string): PanelResult {
  const finding = Finding.parse({ criterionId, severity: 'blocker', expected: 'e', observed: 'o', requiredFix: [`fix ${criterionId}`] });
  const run = { id: 'EVAL-1', perspective: 'codeQuality', findings: [finding] } as unknown as EvalRun;
  return { verdict: 'request_changes', runs: [run], gateFailed: false, escalated: false, perspectives: ['codeQuality'] };
}
const approvingPanel: PanelResult = { verdict: 'approve', runs: [], gateFailed: false, escalated: false, perspectives: [] };

// --- seam 1: the repair brief lands in the generator prompt --------------------------------

const target: TargetRepoConfig = { repo: '.', protectedPaths: ['src/pipeline/**'] };
function genInput(repairBrief: RepairBrief | null, attempt: number): GeneratorSessionInput {
  return { issue: Issue.parse({ id: 'ISSUE-1', type: 'harness', title: 't', area: 'harness', status: 'contract-drafted', assignedAgent: 'mock', contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }), contract, sampleIndex: 0, attempt, repairBrief };
}

describe('buildGeneratorPrompt: a repair attempt carries the reviewers required fixes', () => {
  it('attempt 1 (no brief) has no repair section', () => {
    const prompt = buildGeneratorPrompt(genInput(null, 1), target);
    expect(prompt).not.toContain('## Repair');
    expect(prompt).toContain('## Issue Contract'); // still the normal briefing
  });

  it('a repair attempt appends the required fixes and finding context', () => {
    const brief: RepairBrief = {
      fromEvalRunId: 'EVAL-1',
      findings: [Finding.parse({ criterionId: 'codeQuality:AC-1', severity: 'blocker', expected: 'clear names', observed: 'x/y/z', requiredFix: ['rename x to total'] })],
      instructions: ['rename x to total'],
    };
    const prompt = buildGeneratorPrompt(genInput(brief, 2), target);
    expect(prompt).toContain('## Repair');
    expect(prompt).toContain('rename x to total'); // the instruction
    expect(prompt).toContain('codeQuality:AC-1'); // the finding context
    expect(prompt).toContain('do not regress'); // the amend-don't-restart guidance
  });

  it('a brief with no instructions produces no repair section (nothing to say)', () => {
    const empty: RepairBrief = { fromEvalRunId: '', findings: [], instructions: [] };
    expect(buildGeneratorPrompt(genInput(empty, 2), target)).not.toContain('## Repair');
  });
});

// --- seam 2: the shared loop threads briefs and escalates a stuck generator -----------------

describe('runBoundedRepairLoop: threads the repair brief across attempts', () => {
  it('the second attempt receives a brief derived from the first attempt findings, then converges', async () => {
    const store = tmpStore('live-thread');
    const issue = addIssue(store, 'ISSUE-1');
    store.setStatus('ISSUE-1', 'ready-for-generation');
    store.setStatus('ISSUE-1', 'generation-in-progress');
    const pr = addPR(store, 'ISSUE-1');

    const briefs: (RepairBrief | null)[] = [];
    const res = await runBoundedRepairLoop(store, CONFIG, 'ISSUE-1', pr, async (attempt, brief): Promise<AttemptOutcome> => {
      briefs.push(brief);
      store.setStatus('ISSUE-1', 'ready-for-evaluation');
      store.setStatus('ISSUE-1', 'evaluation-in-progress');
      return { panel: attempt === 1 ? rejectingPanel('codeQuality:AC-1') : approvingPanel };
    });

    expect(briefs[0]).toBeNull(); // attempt 1 = fresh
    expect(briefs[1]).not.toBeNull(); // attempt 2 = repair
    expect(briefs[1]!.instructions).toContain('fix codeQuality:AC-1'); // straight from the first panel
    expect(res.verdict).toBe('approve');
    expect(res.attempts).toBe(2);
    expect(res.status).toBe('needs-human-review'); // gate, never auto-released
    expect(res.escalated).toBe(false);
  });

  it('resumes an existing PR at a fresh attempt with an external gate repair brief', async () => {
    const store = tmpStore('live-resume');
    addIssue(store, 'ISSUE-1');
    store.setStatus('ISSUE-1', 'ready-for-generation');
    store.setStatus('ISSUE-1', 'generation-in-progress');
    store.setStatus('ISSUE-1', 'ready-for-evaluation');
    store.setStatus('ISSUE-1', 'evaluation-in-progress');
    store.setStatus('ISSUE-1', 'changes-requested');
    const pr = addPR(store, 'ISSUE-1');
    pr.attempts = 2;
    store.setStatus('ISSUE-1', 'generation-in-progress');
    const initial: RepairBrief = {
      fromEvalRunId: 'revision-gate:PRGATE-1',
      findings: [Finding.parse({
        criterionId: 'PR-GATE-1',
        severity: 'major',
        expected: 'no P1',
        observed: 'P1 remains',
        requiredFix: ['resolve P1'],
      })],
      instructions: ['resolve P1'],
    };
    const attempts: number[] = [];
    const briefs: Array<RepairBrief | null> = [];

    const result = await runBoundedRepairLoop(
      store,
      { ...CONFIG, maxRepairs: 0 },
      'ISSUE-1',
      pr,
      async (attempt, brief) => {
        attempts.push(attempt);
        briefs.push(brief);
        store.setStatus('ISSUE-1', 'ready-for-evaluation');
        store.setStatus('ISSUE-1', 'evaluation-in-progress');
        return { panel: approvingPanel };
      },
      { startAttempt: 3, initialRepairBrief: initial },
    );

    expect(attempts).toEqual([3]);
    expect(briefs[0]?.instructions).toEqual(['resolve P1']);
    expect(result.attempts).toBe(3);
    expect(result.verdict).toBe('approve');
  });
});

describe('runBoundedRepairLoop: a stuck generator escalates without a silent grade', () => {
  it('a stuck attempt goes straight to the human gate, session kept alive, loop stops', async () => {
    const store = tmpStore('live-stuck');
    addIssue(store, 'ISSUE-1');
    store.setStatus('ISSUE-1', 'ready-for-generation');
    store.setStatus('ISSUE-1', 'generation-in-progress');
    const pr = addPR(store, 'ISSUE-1');

    let calls = 0;
    const res = await runBoundedRepairLoop(store, CONFIG, 'ISSUE-1', pr, async (): Promise<AttemptOutcome> => {
      calls++;
      return { stuck: true };
    });

    expect(calls).toBe(1); // did not keep retrying a stuck session
    expect(res.escalated).toBe(true);
    expect(res.exhausted).toBe(false); // escalated, not exhausted
    expect(res.attempts).toBe(1);
    expect(res.status).toBe('needs-human-review');
    expect(res.verdict).toBe('needs_human'); // no panel ran — needs a human, never a silent pass
    expect(pr.status).toBe('changes-requested');
  });
});

describe('runBoundedRepairLoop: manageIssueStatus=false leaves the issue status for the caller (best-of-N)', () => {
  it('computes the verdict + PR status but never moves the ISSUE status', async () => {
    const store = tmpStore('live-nomanage');
    const issue = addIssue(store, 'ISSUE-1');
    store.setStatus('ISSUE-1', 'ready-for-generation');
    store.setStatus('ISSUE-1', 'generation-in-progress');
    const before = store.getIssue('ISSUE-1')!.status;
    const pr = addPR(store, 'ISSUE-1');

    const res = await runBoundedRepairLoop(store, CONFIG, 'ISSUE-1', pr,
      async (): Promise<AttemptOutcome> => ({ panel: approvingPanel }),
      { manageIssueStatus: false });

    expect(res.verdict).toBe('approve');
    expect(pr.status).toBe('approved'); // PR status still set (per-PR, not per-issue)
    expect(store.getIssue('ISSUE-1')!.status).toBe(before); // issue status untouched — caller owns it
    expect(store.getIssue('ISSUE-1')!.status).not.toBe('needs-human-review');
  });
});
