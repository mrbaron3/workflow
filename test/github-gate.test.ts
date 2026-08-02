/**
 * GitHub PR gate backend (ADR-0006 G1-G3). The git/`gh` I/O is injected as a fake runner, so these
 * exercise the deterministic core: the state→decision map, the store-vs-github backend switch, the
 * projection (openGate) and the poll (pollGate) that feeds a merge/close into recordHumanDecision —
 * including the false-pass harvest onto EvalRun.humanVerdict. No network.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store, nowISO } from '../src/store/store.js';
import {
  Issue,
  PR,
  EvalRun,
  IntakeRecord,
  PrRevision,
  approvePR,
  bindApprovalRevisionToPR,
  evaluateRevisionGateEvidence,
  transitionPrRevision,
} from '../src/domain/schema.js';
import type { IssueStatus } from '../src/domain/states.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  prStateToDecision,
  openGate,
  pollGate,
  prHeadRefspec,
  projectReviewRevision,
  pushGeneratedBranch,
  realGhGateRunner,
  renderGatePrBody,
  renderReviewPrBody,
  type GateCommandRunner,
  type GhGateRunner,
  type GhPrState,
} from '../src/pipeline/execution/gate.js';
import { PERSPECTIVES } from '../src/pipeline/panel.js';
import {
  projectedWorkIdentity,
  renderWorkIdentityMarker,
} from '../src/pipeline/execution/work-identity.js';

const STORE: HarnessConfig = { ...DEFAULT_CONFIG }; // gate absent = store-direct (default)
const GITHUB: HarnessConfig = { ...DEFAULT_CONFIG, gate: { backend: 'github' } };

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

const GATE_WALK: IssueStatus[] = ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress', 'build-approved', 'needs-human-review'];

/** Seed an issue that has reached the review gate with a github-projected PR + approving panel runs. */
function seedGatedIssue(store: Store, id: string, prNumber: number | null): PR {
  store.addIssue(Issue.parse({
    id,
    type: 'harness',
    title: `${id} title`,
    area: 'harness',
    status: 'contract-drafted',
    assignedAgent: 'mock',
    contract,
    planningCandidateKey: id.toLowerCase(),
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }));
  for (const s of GATE_WALK) store.setStatus(id, s);
  const pr = store.addPR(PR.parse({
    id: store.nextId('PR'), issueId: id, branch: `agent/${id.toLowerCase()}-s0`, baseBranch: 'main', generator: 'mock', attempts: 1, status: 'open',
    currentRevisionId: `PRREV-${id}`, headSha: 'a'.repeat(40),
    externalRef: prNumber === null ? null : { provider: 'github', number: prNumber, url: `https://github.com/o/r/pull/${prNumber}` },
    createdAt: nowISO(), updatedAt: nowISO(),
  }));
  for (const { key } of PERSPECTIVES) addRun(store, id, pr, key);
  return pr;
}

function addRun(store: Store, issueId: string, pr: PR, perspective: string): EvalRun {
  if (!pr.currentRevisionId || !pr.headSha) throw new Error('fixture PR must be revision-bound');
  return store.addEvalRun(EvalRun.parse({
    id: store.nextId('EVAL'), issueId, prId: pr.id, attempt: 1, sampleIndex: 0, agent: 'mock', verdict: 'approve', perspective,
    findings: perspective === 'codeQuality' ? [{ criterionId: 'codeQuality:AC-1', severity: 'minor', expected: 'e', observed: 'nit' }] : [],
    scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 }, overall: 1, cost: {}, createdAt: nowISO(),
    revisionId: pr.currentRevisionId,
    headSha: pr.headSha,
  }));
}

function approveSeededPR(store: Store, pr: PR): void {
  if (!pr.currentRevisionId || !pr.headSha) throw new Error('fixture PR must be revision-bound');
  const revision = store.upsertPrRevision(PrRevision.parse({
    id: pr.currentRevisionId,
    prId: pr.id,
    headSha: pr.headSha,
    ordinal: 1,
    status: 'approved',
    createdAt: nowISO(),
  }));
  if (revision.status !== 'approved') throw new Error('fixture revision must be approved');
  const evaluated = evaluateRevisionGateEvidence({
    id: `PRGATE-${pr.id}`,
    pr,
    revision,
    requiredPerspectives: [],
    reviewRuns: [],
    github: {
      state: 'open',
      headSha: revision.headSha,
      isDraft: false,
      mergeability: 'mergeable',
      checks: [],
      unresolvedBlockingThreadIds: [],
    },
    createdAt: nowISO(),
  });
  if (evaluated.decision !== 'approved') throw new Error('fixture gate must approve');
  store.approvePR(approvePR(
    pr,
    bindApprovalRevisionToPR(pr, revision, evaluated),
  ));
}

function fakeRunner(state: GhPrState, prNumber = 42): { runner: GhGateRunner; calls: { push: number; create: number; view: number } } {
  const calls = { push: 0, create: 0, view: 0 };
  const runner: GhGateRunner = {
    preflightPr: (_cwd, args) => args.existingRef,
    pushBranch: () => { calls.push++; },
    createPr: (_cwd, args) => { calls.create++; return { provider: 'github', number: prNumber, url: `https://github.com/o/r/pull/${prNumber}#${args.head}` }; },
    viewPr: () => { calls.view++; return state; },
  };
  return { runner, calls };
}

describe('prStateToDecision: the pure heart of the gate', () => {
  it('merged→approve, closed→reject, open→pending(null)', () => {
    expect(prStateToDecision('merged')).toBe('approve');
    expect(prStateToDecision('closed')).toBe('reject');
    expect(prStateToDecision('open')).toBeNull();
  });
});

describe('trusted AgentOps PR repair projection', () => {
  it('AC-PRLOOP-003 pushes a generated repair HEAD to its stable GitHub PR branch', () => {
    expect(prHeadRefspec('feature/existing-pr')).toBe(
      'HEAD:refs/heads/feature/existing-pr',
    );
  });

  it('publishes through a literal remote when the fetched tracking SHA still matches', () => {
    const fixture = pushLeaseFixture('matching');
    const candidate = commitFile(fixture.worktree, 'candidate.txt', 'candidate');

    pushGeneratedBranch(fixture.worktree, fixture.remote, fixture.branch);

    expect(revParse(fixture.remote, fixture.branch)).toBe(candidate);
  });

  it('uses each successfully published repair head as the next literal-remote lease', () => {
    const fixture = pushLeaseFixture('sequential-repairs');
    const first = commitFile(fixture.worktree, 'first.txt', 'first repair');

    pushGeneratedBranch(fixture.worktree, fixture.remote, fixture.branch);
    const second = commitFile(fixture.worktree, 'second.txt', 'second repair');
    pushGeneratedBranch(fixture.worktree, fixture.remote, fixture.branch);

    expect(revParse(fixture.remote, fixture.branch)).toBe(second);
    expect(revParse(
      fixture.worktree,
      `refs/remotes/origin/${fixture.branch}`,
    )).toBe(second);
    expect(first).not.toBe(second);
  });

  it('fails closed when the remote branch moves after a successful repair push', () => {
    const fixture = pushLeaseFixture('concurrent');
    const first = commitFile(fixture.worktree, 'first.txt', 'first repair');
    pushGeneratedBranch(fixture.worktree, fixture.remote, fixture.branch);
    const concurrent = commitFile(fixture.seed, 'concurrent.txt', 'concurrent');
    git(fixture.seed, ['push', '--force', 'origin', `HEAD:${fixture.branch}`]);
    commitFile(fixture.worktree, 'second.txt', 'second repair');

    expect(() => pushGeneratedBranch(
      fixture.worktree,
      fixture.remote,
      fixture.branch,
    )).toThrow(/stale info/);
    expect(revParse(fixture.remote, fixture.branch)).toBe(concurrent);
    expect(revParse(
      fixture.worktree,
      `refs/remotes/origin/${fixture.branch}`,
    )).toBe(first);
  });

  it('creates a new branch only while the remote destination is absent', () => {
    const fixture = pushLeaseFixture('new-branch', false);
    const candidate = commitFile(fixture.worktree, 'candidate.txt', 'candidate');

    pushGeneratedBranch(fixture.worktree, fixture.remote, fixture.branch);

    expect(revParse(fixture.remote, fixture.branch)).toBe(candidate);
  });
});

describe('realGhGateRunner: stable GitHub PR identity', () => {
  const identity = projectedWorkIdentity({
    repository: 'mrbaron3/designflow',
    issueNumber: 20,
    intakeKey: 'github:mrbaron3%2Fdesignflow:20',
    workUnitKey: 'canonical-json',
    releaseId: 'release-20',
  }, 0);
  const args = {
    base: 'main',
    head: 'agent/issue-0001-s0',
    title: 'ISSUE-0001: title',
    body: `review body\n\n${renderWorkIdentityMarker(identity)}\n\nCloses mrbaron3/designflow#20`,
  };
  const existing = [{
    number: 12,
    url: 'https://github.com/mrbaron3/designflow/pull/12',
    body: args.body,
    headRefName: args.head,
    baseRefName: args.base,
    isCrossRepository: false,
  }];

  it('reuses the unique OPEN PR with the exact head and base', () => {
    const calls: string[][] = [];
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      calls.push(commandArgs);
      return JSON.stringify(existing);
    };

    const ref = realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args);

    expect(ref).toEqual({
      provider: 'github',
      repository: 'mrbaron3/designflow',
      number: 12,
      url: existing[0]!.url,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'pr', 'list', '--repo', 'mrbaron3/designflow',
      '--state', 'open',
      '--head', args.head,
      '--base', args.base,
      '--limit', '2',
      '--json', 'number,url,body,headRefName,baseRefName,isCrossRepository',
    ]);
  });

  it('creates a PR when no matching OPEN PR exists, then resolves its exact identity', () => {
    let listCalls = 0;
    let createCalls = 0;
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') {
        listCalls += 1;
        return JSON.stringify(listCalls === 1 ? [] : existing);
      }
      if (commandArgs[1] === 'create') {
        createCalls += 1;
        return existing[0]!.url;
      }
      throw new Error(`unexpected gh command: ${commandArgs.join(' ')}`);
    };

    const ref = realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args);

    expect(ref.number).toBe(12);
    expect(listCalls).toBe(2);
    expect(createCalls).toBe(1);
  });

  it('adopts an exact OPEN PR created during the gh pr create race', () => {
    let listCalls = 0;
    const observedError = new Error(
      'gh pr create failed: a pull request for branch '
      + '"agent/issue-0001-s0" into branch "main" already exists',
    );
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') {
        listCalls += 1;
        return JSON.stringify(listCalls === 1 ? [] : existing);
      }
      if (commandArgs[1] === 'create') throw observedError;
      throw new Error(`unexpected gh command: ${commandArgs.join(' ')}`);
    };

    const ref = realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args);

    expect(ref.number).toBe(12);
    expect(listCalls).toBe(2);
  });

  it('does not adopt a PR whose head or base differs after create fails', () => {
    const observedError = new Error('gh pr create failed: already exists');
    const wrongIdentity = [{
      ...existing[0],
      headRefName: 'agent/different',
    }];
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') return JSON.stringify(wrongIdentity);
      if (commandArgs[1] === 'create') throw observedError;
      throw new Error(`unexpected gh command: ${commandArgs.join(' ')}`);
    };

    expect(() => realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args)).toThrow(observedError);
  });

  it('does not adopt a fork PR with the same branch and base names', () => {
    const observedError = new Error('gh pr create failed');
    const forkIdentity = [{ ...existing[0], isCrossRepository: true }];
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') return JSON.stringify(forkIdentity);
      if (commandArgs[1] === 'create') throw observedError;
      throw new Error(`unexpected gh command: ${commandArgs.join(' ')}`);
    };

    expect(() => realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args)).toThrow(observedError);
  });

  it('rejects a PR URL outside the canonical GitHub origin', () => {
    let createCalls = 0;
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') {
        return JSON.stringify([{
          ...existing[0],
          url: 'https://example.test/mrbaron3/designflow/pull/12',
        }]);
      }
      createCalls += 1;
      return '';
    };

    expect(() => realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args)).toThrow(/non-canonical origin/);
    expect(createCalls).toBe(0);
  });

  it('fails closed instead of choosing among multiple exact OPEN PRs', () => {
    let createCalls = 0;
    const command: GateCommandRunner = (_cmd, commandArgs) => {
      if (commandArgs[1] === 'list') {
        return JSON.stringify([
          existing[0],
          { ...existing[0], number: 13, url: 'https://github.com/mrbaron3/designflow/pull/13' },
        ]);
      }
      createCalls += 1;
      return '';
    };

    expect(() => realGhGateRunner('mrbaron3/designflow', command)
      .createPr('/repo', args)).toThrow(/multiple open pull requests/);
    expect(createCalls).toBe(0);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(repository: string, name: string, contents: string): string {
  fs.writeFileSync(path.join(repository, name), contents, 'utf8');
  git(repository, ['add', name]);
  git(repository, ['commit', '-m', `test: ${name}`]);
  return revParse(repository, 'HEAD');
}

function revParse(repository: string, ref: string): string {
  return git(repository, ['rev-parse', ref]);
}

function pushLeaseFixture(name: string, existingBranch = true): {
  remote: string;
  seed: string;
  worktree: string;
  branch: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentops-push-lease-${name}-`));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const worktree = path.join(root, 'worktree');
  const branch = 'agent/issue-0001-s0';
  fs.mkdirSync(seed);
  git(root, ['init', '--bare', remote]);
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.name', 'AgentOps Test']);
  git(seed, ['config', 'user.email', 'agentops@example.test']);
  commitFile(seed, 'base.txt', 'base');
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  if (existingBranch) {
    git(seed, ['push', 'origin', `HEAD:${branch}`]);
  }
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['clone', remote, worktree]);
  git(worktree, ['config', 'user.name', 'AgentOps Test']);
  git(worktree, ['config', 'user.email', 'agentops@example.test']);
  git(worktree, ['checkout', '--detach']);
  return { remote, seed, worktree, branch };
}

describe('openGate: project an approved build to the gate UI', () => {
  it('store backend is a no-op — no push, no PR, no externalRef', () => {
    const store = tmpStore('open-store');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const { runner, calls } = fakeRunner('open');
    const ref = openGate(store, STORE, { pr, worktree: '/wt', title: 't' }, runner);
    expect(ref).toBeNull();
    expect(calls).toEqual({ push: 0, create: 0, view: 0 });
    expect(pr.externalRef).toBeNull();
  });

  it('github backend pushes, opens a PR and records externalRef', () => {
    const store = tmpStore('open-github');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const { runner, calls } = fakeRunner('open', 7);
    const ref = openGate(store, GITHUB, { pr, worktree: '/wt', title: 'ISSUE-1: t' }, runner);
    expect(calls.push).toBe(1);
    expect(calls.create).toBe(1);
    expect(ref?.number).toBe(7);
    expect(store.getPR(pr.id)?.externalRef?.number).toBe(7);
    expect(store.getPR(pr.id)?.externalRef?.provider).toBe('github');
  });

  it('is idempotent: a PR that already has an externalRef is not re-created', () => {
    const store = tmpStore('open-idem');
    const pr = seedGatedIssue(store, 'ISSUE-1', 5); // already projected
    const { runner, calls } = fakeRunner('open');
    const ref = openGate(store, GITHUB, { pr, worktree: '/wt', title: 't' }, runner);
    expect(ref?.number).toBe(5);
    expect(calls).toEqual({ push: 0, create: 0, view: 0 }); // no re-push / re-create
  });
});

describe('projectReviewRevision: PR exists before perspective review', () => {
  it('rejects an existing PR Issue/release mismatch before every mutation and fence', async () => {
    const store = tmpStore('review-identity-mismatch');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    seedIntake(store, 'ISSUE-1', 23);
    const expectedIdentity = {
      repository: 'o/r',
      issueNumber: 23,
      intakeKey: 'o/r#23',
      workUnitKey: 'source',
      releaseId: 'release-23',
    };
    const wrongIdentity = projectedWorkIdentity({
      ...expectedIdentity,
      issueNumber: 20,
      intakeKey: 'o/r#20',
      releaseId: 'release-20',
    }, 0);
    const observedCommands: Array<{ command: string; args: string[] }> = [];
    const command: GateCommandRunner = (commandName, commandArgs) => {
      observedCommands.push({ command: commandName, args: commandArgs });
      if (commandName === 'gh' && commandArgs[1] === 'list') {
        return JSON.stringify([{
          number: 21,
          url: 'https://github.com/o/r/pull/21',
          body: `review\n\n${renderWorkIdentityMarker(wrongIdentity)}\n\nCloses o/r#20`,
          headRefName: pr.branch,
          baseRefName: 'main',
          isCrossRepository: false,
        }]);
      }
      throw new Error(`unexpected command: ${commandName} ${commandArgs.join(' ')}`);
    };
    let pushFenceCalls = 0;
    let createFenceCalls = 0;

    await expect(projectReviewRevision(
      store,
      GITHUB,
      {
        pr,
        worktree: '/wt',
        title: 'ISSUE-1: title',
        headSha: 'a'.repeat(40),
        workIdentity: expectedIdentity,
        sampleIndex: 0,
      },
      realGhGateRunner('o/r', command),
      () => {},
      async () => { createFenceCalls += 1; },
      async () => { pushFenceCalls += 1; },
    )).rejects.toThrow(/external Issue\/release identity/);

    expect(observedCommands).toHaveLength(1);
    expect(observedCommands[0]).toMatchObject({ command: 'gh' });
    expect(observedCommands[0]!.args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(pushFenceCalls).toBe(0);
    expect(createFenceCalls).toBe(0);
    expect(store.db.prRevisions).toHaveLength(0);
    expect(store.getPR(pr.id)?.externalRef).toBeNull();
  });

  it('refuses an ambiguous existing remote branch before force-push', async () => {
    const store = tmpStore('review-ambiguous-branch');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    seedIntake(store, 'ISSUE-1', 23);
    const identity = {
      repository: 'o/r',
      issueNumber: 23,
      intakeKey: 'o/r#23',
      workUnitKey: 'source',
      releaseId: 'release-23',
    };
    const observedCommands: Array<{ command: string; args: string[] }> = [];
    const command: GateCommandRunner = (commandName, commandArgs) => {
      observedCommands.push({ command: commandName, args: commandArgs });
      if (commandName === 'gh') return '[]';
      if (commandName === 'git' && commandArgs[0] === 'ls-remote') {
        return `${'b'.repeat(40)}\trefs/heads/${pr.branch}\n`;
      }
      throw new Error(`unexpected command: ${commandName} ${commandArgs.join(' ')}`);
    };
    let pushFenceCalls = 0;

    await expect(projectReviewRevision(
      store,
      GITHUB,
      {
        pr,
        worktree: '/wt',
        title: 'ISSUE-1: title',
        headSha: 'a'.repeat(40),
        workIdentity: identity,
        sampleIndex: 0,
      },
      realGhGateRunner('o/r', command),
      () => {},
      undefined,
      async () => { pushFenceCalls += 1; },
    )).rejects.toThrow(/ambiguous existing branch/);

    expect(observedCommands.map((entry) => entry.command)).toEqual(['gh', 'git']);
    expect(pushFenceCalls).toBe(0);
    expect(store.db.prRevisions).toHaveLength(0);
  });

  it('fails closed after push when the fresh PR-create fence rejects', async () => {
    const store = tmpStore('review-create-fence');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const calls: string[] = [];
    const runner: GhGateRunner = {
      preflightPr: (_cwd, args) => args.existingRef,
      pushBranch: () => { calls.push('push'); },
      createPr: () => {
        calls.push('create');
        return {
          provider: 'github',
          number: 9,
          url: 'https://github.com/o/r/pull/9',
        };
      },
      viewPr: () => 'open',
    };
    await expect(projectReviewRevision(
      store,
      GITHUB,
      {
        pr,
        worktree: '/wt',
        title: 'ISSUE-1: title',
        headSha: 'a'.repeat(40),
      },
      runner,
      () => {},
      async () => {
        throw new Error('registration disabled after push');
      },
    )).rejects.toThrow(/registration disabled/);
    expect(calls).toEqual(['push']);
  });

  it('AC-PRLOOP-001 creates the PR on the first head, then pushes repairs to the same PR', async () => {
    const store = tmpStore('review-revisions');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const pushes: string[] = [];
    const bodies: string[] = [];
    const runner: GhGateRunner = {
      preflightPr: (_cwd, args) => args.existingRef,
      pushBranch: (_worktree, branch) => { pushes.push(branch); },
      createPr: (_cwd, args) => {
        bodies.push(args.body);
        return {
          provider: 'github',
          number: 8,
          url: 'https://github.com/o/r/pull/8',
        };
      },
      viewPr: () => 'open',
    };
    const firstSha = 'a'.repeat(40);
    const secondSha = 'b'.repeat(40);

    const first = await projectReviewRevision(
      store,
      GITHUB,
      { pr, worktree: '/wt', title: 'ISSUE-1: title', headSha: firstSha },
      runner,
    );
    const reviewingFirst = store.replacePrRevision(transitionPrRevision(first, {
      status: 'reviewing',
    }));
    store.replacePrRevision(transitionPrRevision(reviewingFirst, { status: 'approved' }));
    const second = await projectReviewRevision(
      store,
      GITHUB,
      { pr, worktree: '/wt', title: 'ISSUE-1: title', headSha: secondSha },
      runner,
    );

    expect(pushes).toEqual([pr.branch, pr.branch]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('current-head');
    expect(bodies[0]).not.toContain('自動評価パネルはこのビルドを**承認**');
    expect(store.getPR(pr.id)?.externalRef?.number).toBe(8);
    expect(store.getPR(pr.id)?.agentGeneratedHeadSha).toBe(secondSha);
    expect(store.revisionForHead(pr.id, firstSha)?.status).toBe('stale');
    expect(second).toMatchObject({ headSha: secondSha, ordinal: 2 });
  });

  it('uses Refs, not Closes, while a split source still has sibling work', () => {
    const store = tmpStore('review-body-split');
    seedGatedIssue(store, 'ISSUE-1', 1);
    seedGatedIssue(store, 'ISSUE-2', 2);
    seedIntake(store, ['ISSUE-1', 'ISSUE-2'], 9);

    expect(renderReviewPrBody(store, 'ISSUE-1')).toContain('Refs o/r#9');
    expect(renderReviewPrBody(store, 'ISSUE-1')).not.toContain('Closes o/r#9');
  });
});

describe('pollGate: a merge/close becomes the human decision', () => {
  it('store backend is a no-op (nothing to poll)', () => {
    const store = tmpStore('poll-store');
    seedGatedIssue(store, 'ISSUE-1', 1);
    expect(pollGate(store, STORE, fakeRunner('merged').runner, '/repo')).toEqual([]);
  });

  it('merged → released + humanVerdict=approve without fabricating revision coordinates', () => {
    const store = tmpStore('poll-merged');
    const pr = seedGatedIssue(store, 'ISSUE-1', 1);
    approveSeededPR(store, pr);
    const res = pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo')[0]!;
    expect(res.decision).toBe('approve');
    expect(res.changed).toBe(true);
    expect(store.getIssue('ISSUE-1')!.status).toBe('released');
    expect(store.runsForIssue('ISSUE-1').every((r) => r.humanVerdict === 'approve')).toBe(true);
    // This compatibility runner only returns a lifecycle state, not the merged
    // commit SHA. Keep the last correlated approved identity instead of
    // manufacturing a merged PR variant with unproven coordinates.
    expect(store.prForIssue('ISSUE-1')!.status).toBe('approved');
    expect(store.prForIssue('ISSUE-1')!.mergedHeadSha).toBeNull();
  });

  it('closed → repair lane + humanVerdict=request_changes (a false-pass the panel let through)', () => {
    const store = tmpStore('poll-closed');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const res = pollGate(store, GITHUB, fakeRunner('closed').runner, '/repo')[0]!;
    expect(res.decision).toBe('reject');
    expect(store.getIssue('ISSUE-1')!.status).toBe('changes-requested');
    expect(store.runsForIssue('ISSUE-1').every((r) => r.humanVerdict === 'request_changes')).toBe(true);
  });

  it('still-open PR is left pending — no decision, no state change', () => {
    const store = tmpStore('poll-open');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const res = pollGate(store, GITHUB, fakeRunner('open').runner, '/repo')[0]!;
    expect(res.decision).toBeNull();
    expect(res.changed).toBe(false);
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
  });

  it('is idempotent: a released issue is no longer needs-human-review, so a re-poll skips it', () => {
    const store = tmpStore('poll-idem');
    seedGatedIssue(store, 'ISSUE-1', 1);
    pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo');
    const second = pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo');
    expect(second).toEqual([]); // nothing left at the gate
  });

  it('only polls github-projected PRs — an unprojected needs-human-review issue is skipped', () => {
    const store = tmpStore('poll-unprojected');
    seedGatedIssue(store, 'ISSUE-1', null); // no externalRef
    expect(pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo')).toEqual([]);
  });
});

/** Seed the intake record that ties one or more store issues back to a source GitHub Issue. */
function seedIntake(store: Store, issueIds: string | string[], number: number): void {
  store.addIntakeRecord(IntakeRecord.parse({
    id: store.nextId('INTAKE'), intakeKey: `o/r#${number}`, provider: 'github',
    snapshot: {
      repository: 'o/r', number, externalId: String(number), title: 't', body: 'b',
      url: `https://github.com/o/r/issues/${number}`, labels: [], state: 'open',
      sourceUpdatedAt: nowISO(), snapshotAt: nowISO(),
    },
    status: 'claimed', claimedAt: nowISO(),
    storeIssueIds: Array.isArray(issueIds) ? issueIds : [issueIds],
    createdAt: nowISO(), updatedAt: nowISO(),
  }));
}

describe('renderGatePrBody: human-readable panel render', () => {
  it('lists each perspective verdict and its findings, in Japanese prose', () => {
    const store = tmpStore('body');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const body = renderGatePrBody(store, 'ISSUE-1');
    expect(body).toContain('承認');
    expect(body).toContain('functionality');
    expect(body).toContain('codeQuality');
    expect(body).toContain('codeQuality:AC-1'); // the finding
  });

  it('links the source GitHub issue so a merge closes it', () => {
    const store = tmpStore('body-closes');
    seedGatedIssue(store, 'ISSUE-1', 1);
    seedIntake(store, 'ISSUE-1', 9);
    expect(renderGatePrBody(store, 'ISSUE-1')).toContain('Closes o/r#9');
  });

  it('does not close a source GitHub issue from any one child when intake split it', () => {
    const store = tmpStore('body-split-refs');
    seedGatedIssue(store, 'ISSUE-1', 1);
    seedGatedIssue(store, 'ISSUE-2', 2);
    seedIntake(store, ['ISSUE-1', 'ISSUE-2'], 9);

    for (const issueId of ['ISSUE-1', 'ISSUE-2']) {
      const body = renderGatePrBody(store, issueId);
      expect(body).toContain('Refs o/r#9');
      expect(body).not.toContain('Closes o/r#9');
    }
  });

  it('omits the Closes line when the issue has no external source', () => {
    const store = tmpStore('body-no-source');
    seedGatedIssue(store, 'ISSUE-1', 1);
    expect(renderGatePrBody(store, 'ISSUE-1')).not.toContain('Closes');
  });
});
