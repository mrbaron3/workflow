import { describe, expect, it, vi } from 'vitest';
import {
  realReviewChildGithub,
  renderReviewChildIssue,
  reviewChildMarker,
} from '../src/pipeline/execution/review-children.js';

const parentReleaseId = '11111111-1111-4111-8111-111111111111';
const parentHeadSha = 'a'.repeat(40);
const input = () => ({
  repository: 'mrbaron3/servo',
  readyLabel: 'ready',
  parentReleaseId,
  parentIssueNumber: 41,
  parentPullRequestNumber: 52,
  parentBranch: 'agent/issue-41',
  parentHeadSha,
  reviewRound: 2,
  perspective: 'security',
  findingIdentity: `finding-origin-v1:${'b'.repeat(64)}`,
  finding: {
    criterionId: 'SEC-boundary',
    severity: 'major' as const,
    expected: 'an independently testable hardening boundary',
    observed: 'the adjacent subsystem has no authorization guard',
    requiredFix: ['add the independent authorization boundary'],
    disposition: 'separate-issue' as const,
    separationReason: 'The adjacent subsystem is outside the accepted parent contract.',
  },
});

describe('review-discovered child Issue projection', () => {
  it('binds exact parent lineage and never targets the default branch', () => {
    const rendered = renderReviewChildIssue(input());
    expect(rendered.body).toContain('Repository: mrbaron3/servo');
    expect(rendered.body).toContain('Finding source issue: #41');
    expect(rendered.body).toContain('Finding source PR: #52');
    expect(rendered.body).toContain('Review round: 2');
    expect(rendered.body).toContain('agent/issue-41');
    expect(rendered.body).toContain(parentHeadSha);
    expect(rendered.body).toContain(
      reviewChildMarker(parentReleaseId, rendered.findingKey),
    );
    expect(rendered.body).not.toContain('target the default branch directly.\nmain');
  });

  it('is idempotent across retry and refuses duplicate marker matches', () => {
    const issues: Array<Record<string, unknown>> = [];
    const command = vi.fn((file: string, args: string[]) => {
      expect(file).toBe('gh');
      if (args[0] === 'api') return JSON.stringify([issues]);
      if (args[0] === 'issue' && args[1] === 'create') {
        const rendered = renderReviewChildIssue(input());
        issues.push({
          number: 77,
          html_url: 'https://github.com/mrbaron3/servo/issues/77',
          body: rendered.body,
        });
        return 'https://github.com/mrbaron3/servo/issues/77';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const github = realReviewChildGithub('/tmp', command);
    expect(github.ensureChildIssue(input())).toMatchObject({ number: 77 });
    expect(github.ensureChildIssue(input())).toMatchObject({ number: 77 });
    expect(command.mock.calls.filter(([, args]) => args[0] === 'issue')).toHaveLength(1);

    issues.push({ ...issues[0], number: 78 });
    expect(() => github.ensureChildIssue(input())).toThrow(/duplicate child issues/);
  });

  it('rejects a current-change finding at the child side-effect boundary', () => {
    expect(() => renderReviewChildIssue({
      ...input(),
      finding: {
        ...input().finding,
        disposition: 'in-change' as const,
        separationReason: undefined,
      },
    })).toThrow(/separate-issue/);
  });
});
