import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GithubIssueSnapshot,
  IntakeRecord,
  Issue,
} from '../src/domain/schema.js';
import { externalWorkIdentityFor } from '../src/pipeline/execution/live.js';
import {
  realGhGateRunner,
  renderReviewPrBody,
  type GateCommandRunner,
} from '../src/pipeline/execution/gate.js';
import {
  parsePullRequestClosingTarget,
  parseWorkIdentityMarker,
  projectedWorkIdentity,
  sampleKey,
} from '../src/pipeline/execution/work-identity.js';
import { Store, nowISO } from '../src/store/store.js';

const contract = {
  productGoal: 'Keep canonical content identities deterministic.',
  userStory: 'As a maintainer, I want a focused compatibility fix.',
  scope: { include: ['src/**', 'test/**'], exclude: [] },
  acceptanceCriteria: [{
    id: 'AC-1',
    severity: 'blocker' as const,
    behavior: 'The requested compatibility behavior is locked.',
    verification: { method: 'unit_test' as const, expected: ['focused regression passes'] },
  }],
  redLines: [],
};

function freshExternalStore(
  issueNumber: number,
  releaseId: string,
  planningCandidateKey = 'canonical-json-compatibility',
): { store: Store; issue: ReturnType<typeof Issue.parse>; releaseId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `external-work-${issueNumber}-`));
  const store = new Store(root);
  const intakeKey = `github:${encodeURIComponent('mrbaron3/forma')}:${issueNumber}`;
  const issue = Issue.parse({
    id: store.nextId('ISSUE'),
    type: 'feature',
    title: `External issue ${issueNumber}`,
    area: 'backend',
    status: 'contract-drafted',
    assignedAgent: 'mock',
    contract,
    intakeKey,
    planningCandidateKey,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  store.addIssue(issue);
  store.addIntakeRecord(IntakeRecord.parse({
    id: store.nextId('INTAKE'),
    intakeKey,
    provider: 'github',
    snapshot: GithubIssueSnapshot.parse({
      repository: 'mrbaron3/forma',
      number: issueNumber,
      externalId: `I_${issueNumber}`,
      title: issue.title,
      body: 'Fixture',
      url: `https://github.com/mrbaron3/forma/issues/${issueNumber}`,
      labels: ['agent-claimed'],
      state: 'open',
      sourceUpdatedAt: nowISO(),
      snapshotAt: nowISO(),
    }),
    status: 'ready',
    claimedAt: nowISO(),
    storeIssueIds: [issue.id],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }));
  return { store, issue, releaseId };
}

describe('stable external work identity', () => {
  it('keeps fresh Store ISSUE-0001 projections distinct for external #20 and #23', () => {
    const issue20 = freshExternalStore(20, '3eec93d7-4044-4dfc-b75c-2975561e50a3');
    const issue23 = freshExternalStore(23, 'fc7b9a5d-0a8e-4362-8d0d-bc6f167ce1ec');
    expect(issue20.issue.id).toBe('ISSUE-0001');
    expect(issue23.issue.id).toBe('ISSUE-0001');

    const identity20 = externalWorkIdentityFor(
      issue20.store,
      issue20.issue,
      issue20.releaseId,
    )!;
    const identity23 = externalWorkIdentityFor(
      issue23.store,
      issue23.issue,
      issue23.releaseId,
    )!;
    const branch20 = `agent/${sampleKey(issue20.issue.id, 0, identity20)}`;
    const branch23 = `agent/${sampleKey(issue23.issue.id, 0, identity23)}`;

    expect(branch20).not.toBe(branch23);
    expect(branch20).toContain('mrbaron3-forma-issue-20');
    expect(branch23).toContain('mrbaron3-forma-issue-23');

    const body20 = renderReviewPrBody(
      issue20.store,
      issue20.issue.id,
      projectedWorkIdentity(identity20, 0),
    );
    const body23 = renderReviewPrBody(
      issue23.store,
      issue23.issue.id,
      projectedWorkIdentity(identity23, 0),
    );
    expect(parseWorkIdentityMarker(body20)).not.toEqual(parseWorkIdentityMarker(body23));
    expect(parsePullRequestClosingTarget(body20)).toEqual({
      relation: 'Closes',
      repository: 'mrbaron3/forma',
      issueNumber: 20,
    });
    expect(parsePullRequestClosingTarget(body23)).toEqual({
      relation: 'Closes',
      repository: 'mrbaron3/forma',
      issueNumber: 23,
    });
  });

  it('converges separate same-release retries onto the same branch and PR correlation', () => {
    const first = freshExternalStore(
      20,
      '3eec93d7-4044-4dfc-b75c-2975561e50a3',
      'canonical-json-compatibility',
    );
    const retry = freshExternalStore(
      20,
      '3eec93d7-4044-4dfc-b75c-2975561e50a3',
      'replanned-display-key',
    );
    const firstIdentity = externalWorkIdentityFor(first.store, first.issue, first.releaseId)!;
    const retryIdentity = externalWorkIdentityFor(retry.store, retry.issue, retry.releaseId)!;
    const branch = `agent/${sampleKey(first.issue.id, 0, firstIdentity)}`;
    const firstBody = renderReviewPrBody(
      first.store,
      first.issue.id,
      projectedWorkIdentity(firstIdentity, 0),
    );
    const retryBody = renderReviewPrBody(
      retry.store,
      retry.issue.id,
      projectedWorkIdentity(retryIdentity, 0),
    );

    expect(sampleKey(first.issue.id, 0, firstIdentity)).toBe(
      sampleKey(retry.issue.id, 0, retryIdentity),
    );
    expect(firstBody).toBe(retryBody);

    const command: GateCommandRunner = (commandName, args) => {
      if (commandName === 'gh') {
        return JSON.stringify([{
          number: 44,
          url: 'https://github.com/mrbaron3/forma/pull/44',
          title: 'ISSUE-0001: retry',
          body: firstBody,
          headRefName: branch,
          baseRefName: 'main',
          isCrossRepository: false,
        }]);
      }
      if (commandName === 'git' && args[0] === 'ls-remote') {
        return `${'a'.repeat(40)}\trefs/heads/${branch}\n`;
      }
      throw new Error(`unexpected command: ${commandName} ${args.join(' ')}`);
    };
    expect(realGhGateRunner('mrbaron3/forma', command).preflightPr('/repo', {
      base: 'main',
      head: branch,
      title: 'ISSUE-0001: retry',
      body: retryBody,
      existingRef: null,
    })).toEqual({
      provider: 'github',
      repository: 'mrbaron3/forma',
      number: 44,
      url: 'https://github.com/mrbaron3/forma/pull/44',
    });
  });
});
