import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { Issue, PR } from '../src/domain/schema.js';
import { runGithubDevelopmentTurn } from '../src/intake/development-turn.js';
import {
  discoverRepositoryPullRequests,
} from '../src/pipeline/execution/repository-pr.js';
import type {
  GithubOpenPullRequest,
  PrNativeGithubRunner,
} from '../src/pipeline/execution/pr-native.js';
import { Store, nowISO } from '../src/store/store.js';

const roots: string[] = [];
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-repository-pr-'));
  roots.push(root);
  const store = new Store(root);
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    routes: {
      generator: { provider: 'codex' },
      reviewer: { provider: 'claude' },
    },
    intake: {
      backend: 'github',
      repository: 'acme/theme',
      readyLabel: 'ready',
      claimedLabel: 'agent-claimed',
    },
    gate: { backend: 'github', baseBranch: 'main' },
    target: { repo: '.', baseRef: 'HEAD', graders: {} },
  };
  const pulls: GithubOpenPullRequest[] = [{
    number: 9,
    url: 'https://github.com/acme/theme/pull/9',
    title: 'Repository-wide PR discovery',
    body: 'Review every current head without per-PR registration.',
    headRefName: 'feature/discovery',
    headSha: SHA_A,
    baseRefName: 'main',
    isDraft: true,
    isCrossRepository: false,
  }];
  const runner: PrNativeGithubRunner = {
    listOpenPullRequests: () => pulls,
    viewRevision: () => ({
      state: 'open',
      headSha: pulls[0]!.headSha,
      isDraft: pulls[0]!.isDraft,
      mergeability: 'mergeable',
      checks: [],
      unresolvedBlockingThreadIds: [],
    }),
    resolveReviewThread: () => {},
    merge: () => {},
    closeIssue: () => {},
  };
  return { root, store, config, pulls, runner };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('repository-wide pull request discovery', () => {
  it('AC-PRLOOP-005 imports an existing open PR exactly once and creates a current-head review work unit', () => {
    const env = setup();

    const first = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    );
    const second = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    );

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      imported: true,
      reviewRequired: true,
      pullRequest: { number: 9, headSha: SHA_A },
      pr: {
        origin: 'repository-discovery',
        branch: 'feature/discovery',
        baseBranch: 'main',
        headSha: SHA_A,
      },
      issue: {
        status: 'ready-for-evaluation',
        assignedAgent: 'codex',
      },
      revision: { headSha: SHA_A, ordinal: 1, status: 'pending' },
    });
    expect(second[0]?.imported).toBe(false);
    expect(env.store.db.prs).toHaveLength(1);
    expect(env.store.db.issues).toHaveLength(1);
    expect(env.store.db.prRevisions).toHaveLength(1);
    expect(new Store(env.root).db.prs[0]?.externalRef?.number).toBe(9);
  });

  it('AC-PRLOOP-005 invalidates old evidence and schedules a fresh review when GitHub advances the head', () => {
    const env = setup();
    const first = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    )[0]!;
    first.revision.status = 'approved';
    env.pulls[0]!.headSha = SHA_B;

    const updated = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    )[0]!;

    expect(first.revision.status).toBe('stale');
    expect(updated).toMatchObject({
      imported: false,
      reviewRequired: true,
      revision: { headSha: SHA_B, ordinal: 2, status: 'pending' },
    });
    expect(env.store.db.prs).toHaveLength(1);
    expect(env.store.db.prRevisions).toHaveLength(2);
  });

  it('AC-PRLOOP-005 deduplicates a PR already owned by the Issue pipeline without synthetic intake', () => {
    const env = setup();
    const issue = env.store.addIssue(Issue.parse({
      id: 'ISSUE-9000',
      type: 'feature',
      title: 'Existing Issue work unit',
      area: 'backend',
      status: 'needs-human-review',
      assignedAgent: 'codex',
      contract: {
        productGoal: 'ship',
        userStory: 'review existing work',
        scope: { include: [], exclude: [] },
        acceptanceCriteria: [{
          id: 'AC-1',
          severity: 'blocker',
          behavior: 'works',
          verification: { method: 'scope_check', expected: ['works'] },
        }],
        redLines: [],
      },
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }));
    env.store.addPR(PR.parse({
      id: 'PR-9000',
      issueId: issue.id,
      branch: 'feature/discovery',
      generator: 'codex',
      externalRef: {
        provider: 'github',
        number: 9,
        url: 'https://github.com/acme/theme/pull/9',
      },
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }));

    const discovered = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    );

    expect(discovered[0]).toMatchObject({
      imported: false,
      reviewRequired: false,
      pr: { id: 'PR-9000', origin: 'issue-pipeline' },
      issue: { id: 'ISSUE-9000' },
    });
    expect(env.store.db.issues).toHaveLength(1);
    expect(env.store.db.prs).toHaveLength(1);
  });

  it('AC-PRLOOP-005 does not auto-manage a fork head because the repair branch is not writable in the target repository', () => {
    const env = setup();
    env.pulls[0]!.isCrossRepository = true;

    const discovered = discoverRepositoryPullRequests(
      env.store,
      env.config,
      env.runner,
      env.root,
    );

    expect(discovered).toEqual([]);
    expect(env.store.db.prs).toEqual([]);
    expect(env.store.db.issues).toEqual([]);
  });

  it('AC-PRLOOP-005 the recurring GitHub turn discovers a repository PR and dispatches its reviewer without item registration', async () => {
    const env = setup();
    const reviewed: number[] = [];

    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
      prNativeRunner: env.runner,
      repositoryPullRequestReviewer: async (discovery) => {
        reviewed.push(discovery.pullRequest.number);
        return {
          prId: discovery.pr.id,
          revisionId: discovery.revision.id,
          headSha: discovery.revision.headSha,
          verdict: 'approve',
        };
      },
      driveQueue: async () => [],
    }, env.root);

    expect(reviewed).toEqual([9]);
    expect(env.store.db.prs[0]).toMatchObject({
      origin: 'repository-discovery',
      externalRef: { number: 9 },
    });
  });
});
