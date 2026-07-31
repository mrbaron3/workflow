import { describe, expect, it, vi } from 'vitest';
import {
  realPlanningHumanReviewGitHub,
  renderPlanningHumanReviewComment,
  type PlanningHumanReviewCommand,
} from '../src/triage/planning-human-review.js';

describe('planning human-review GitHub projection', () => {
  it('renders recorded planning reasons verbatim and keeps ready approval human-owned', () => {
    const reasons = [
      'planning ambiguity: Which conflict policy should be authoritative?',
      'planning ambiguity: Keep ``` in the recorded source without breaking the block',
    ];
    const rendered = renderPlanningHumanReviewComment({
      repository: 'acme/widgets',
      issueNumber: 7,
      reasons,
      readyLabel: 'human-approved',
    });

    expect(rendered.body.startsWith(`${rendered.marker}\n`)).toBe(true);
    for (const reason of reasons) {
      expect(rendered.body.match(new RegExp(
        reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'g',
      ))).toHaveLength(1);
    }
    expect(rendered.body).toContain('人間の WHAT 判断');
    expect(rendered.body).toContain('HOW への人間介入でも provider 障害でもなく');
    expect(rendered.body).toContain(
      'AgentOps はこの停止では `human-approved` を付けません。',
    );
    expect(renderPlanningHumanReviewComment({
      repository: 'acme/widgets',
      issueNumber: 7,
      reasons,
      readyLabel: 'human-approved',
    })).toEqual(rendered);
  });

  it('creates one managed comment idempotently and only removes the claimed label', () => {
    const calls: string[][] = [];
    let managedComment: { body: string; html_url: string } | null = null;
    let claimedPresent = true;
    const command: PlanningHumanReviewCommand = vi.fn(
      (args: readonly string[]) => {
        calls.push([...args]);
        const endpoint = args.find((argument) =>
          argument.startsWith('/repos/')) ?? '';
        if (args.includes('--slurp')) {
          return JSON.stringify(managedComment ? [[managedComment]] : [[]]);
        }
        if (args.includes('POST') && endpoint.endsWith('/comments')) {
          const bodyArgument = args.find((argument) =>
            argument.startsWith('body='))!;
          managedComment = {
            body: bodyArgument.slice('body='.length),
            html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1',
          };
          return JSON.stringify(managedComment);
        }
        if (args.length === 2 && endpoint.endsWith('/issues/7')) {
          return JSON.stringify({
            labels: claimedPresent
              ? [{ name: 'automation-owned' }, { name: 'enhancement' }]
              : [{ name: 'enhancement' }],
          });
        }
        if (args.includes('DELETE')) {
          claimedPresent = false;
          return '';
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    );
    const github = realPlanningHumanReviewGitHub('/workspace', command);
    const comment = renderPlanningHumanReviewComment({
      repository: 'acme/widgets',
      issueNumber: 7,
      reasons: ['planning ambiguity: choose a retention policy'],
      readyLabel: 'human-approved',
    });

    expect(github.ensureManagedComment(
      'acme/widgets',
      7,
      comment,
    )).toBe('https://github.com/acme/widgets/issues/7#issuecomment-1');
    expect(github.ensureManagedComment(
      'acme/widgets',
      7,
      comment,
    )).toBe('https://github.com/acme/widgets/issues/7#issuecomment-1');
    github.removeClaimedLabel('acme/widgets', 7, 'automation-owned');
    github.removeClaimedLabel('acme/widgets', 7, 'automation-owned');

    const commentCreates = calls.filter((args) =>
      args.includes('POST')
      && args.some((argument) => argument.endsWith('/comments')));
    const labelMutations = calls.filter((args) =>
      args.includes('DELETE')
      && args.some((argument) => argument.includes('/labels/')));
    expect(commentCreates).toHaveLength(1);
    expect(labelMutations).toHaveLength(1);
    expect(labelMutations[0]).toContain(
      '/repos/acme/widgets/issues/7/labels/automation-owned',
    );
    expect(calls.some((args) =>
      args.includes('POST')
      && args.some((argument) => argument.includes('/labels')))).toBe(false);
  });
});
