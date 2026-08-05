import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CanonicalRepository, GitHubLabelNameContract } from '../../control-store/types.js';
import { DevelopmentReviewFinding } from '../../domain/development-review.js';
import { runCommand as run } from './command.js';

const GithubIssues = z.array(z.array(z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
}).passthrough()));

export interface SeparateReviewFinding {
  identity: string;
  perspective: string;
  finding: DevelopmentReviewFinding;
}

export interface EnsureReviewChildInput {
  repository: string;
  readyLabel: string;
  parentReleaseId: string;
  parentIssueNumber: number;
  parentPullRequestNumber: number;
  parentBranch: string;
  parentHeadSha: string;
  reviewRound: number;
  perspective: string;
  findingIdentity: string;
  finding: DevelopmentReviewFinding;
}

export interface ReviewChildIssue {
  number: number;
  url: string;
  findingKey: string;
}

export interface ReviewChildGithub {
  ensureChildIssue(input: EnsureReviewChildInput): ReviewChildIssue;
}

const EnsureReviewChild = z.object({
  repository: CanonicalRepository,
  readyLabel: GitHubLabelNameContract,
  parentReleaseId: z.string().uuid(),
  parentIssueNumber: z.number().int().positive(),
  parentPullRequestNumber: z.number().int().positive(),
  parentBranch: z.string().trim().min(1).max(500),
  parentHeadSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  reviewRound: z.number().int().positive().max(1_000),
  perspective: z.string().trim().min(1).max(100),
  findingIdentity: z.string().trim().min(1).max(1_000),
  finding: DevelopmentReviewFinding,
}).strict();

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function reviewFindingKey(
  parentReleaseId: string,
  findingIdentity: string,
): string {
  return `sha256:${digest({ parentReleaseId, findingIdentity })}`;
}

export function reviewChildMarker(
  parentReleaseId: string,
  findingKey: string,
): string {
  return `<!-- agentops-review-child:v1 parent-release=${parentReleaseId} finding=${findingKey} -->`;
}

export function renderReviewChildIssue(input: EnsureReviewChildInput): {
  title: string;
  body: string;
  findingKey: string;
} {
  const parsed = EnsureReviewChild.parse(input);
  const { repository, readyLabel, finding } = parsed;
  if (finding.disposition !== 'separate-issue') {
    throw new Error('review child requires separate-issue disposition');
  }
  const findingKey = reviewFindingKey(
    parsed.parentReleaseId,
    parsed.findingIdentity,
  );
  const marker = reviewChildMarker(parsed.parentReleaseId, findingKey);
  const title = `[review follow-up] ${finding.criterionId}: ${finding.expected}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const body = [
    marker,
    '',
    '## Origin',
    '',
    `- Repository: ${repository}`,
    `- Finding source issue: #${parsed.parentIssueNumber}`,
    `- Finding source PR: #${parsed.parentPullRequestNumber}`,
    `- Review round: ${parsed.reviewRound}`,
    `- Perspective: ${parsed.perspective}`,
    `- Parent integration branch: \`${parsed.parentBranch}\``,
    `- Exact parent head: \`${parsed.parentHeadSha}\``,
    `- Finding identity: \`${parsed.findingIdentity}\``,
    '',
    '## Independently scoped problem',
    '',
    finding.separationReason!,
    '',
    '## Finding',
    '',
    `Expected: ${finding.expected}`,
    '',
    `Observed: ${finding.observed}`,
    '',
    'Required fix:',
    ...finding.requiredFix.map((fix) => `- ${fix}`),
    '',
    '## Integration contract',
    '',
    `Start from exact parent head \`${parsed.parentHeadSha}\`, use an isolated worktree,`,
    `and target the child PR to \`${parsed.parentBranch}\`. Do not target the default`,
    'branch directly. The parent PR remains blocked until this child is integrated and',
    'the cumulative parent head passes its complete graders and review panel.',
    '',
    `Automation-ready label: \`${readyLabel}\`.`,
  ].join('\n');
  return { title, body, findingKey };
}

export type ReviewChildCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => string;

export function realReviewChildGithub(
  cwd: string,
  command: ReviewChildCommandRunner = run,
): ReviewChildGithub {
  const list = (repository: string, marker: string) => {
    const pages = GithubIssues.parse(JSON.parse(command('gh', [
      'api', '--method', 'GET', '--paginate', '--slurp',
      `repos/${repository}/issues?state=all&per_page=100`,
    ], cwd)));
    return pages.flatMap((page) => page)
      .filter((issue) => issue.pull_request === undefined)
      .filter((issue) => issue.body?.includes(marker));
  };
  return {
    ensureChildIssue(rawInput) {
      const input = EnsureReviewChild.parse(rawInput);
      const rendered = renderReviewChildIssue(input);
      const marker = reviewChildMarker(input.parentReleaseId, rendered.findingKey);
      const existing = list(input.repository, marker);
      if (existing.length > 1) {
        throw new Error(`review finding has ${existing.length} duplicate child issues`);
      }
      if (existing[0]) {
        return {
          number: existing[0].number,
          url: existing[0].html_url,
          findingKey: rendered.findingKey,
        };
      }
      const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'agentops-review-child-'),
      );
      fs.chmodSync(temporaryRoot, 0o700);
      const bodyFile = path.join(temporaryRoot, 'body.md');
      fs.writeFileSync(bodyFile, rendered.body, { encoding: 'utf8', mode: 0o600 });
      try {
        command('gh', [
          'issue', 'create', '--repo', input.repository,
          '--title', rendered.title, '--body-file', bodyFile,
          '--label', input.readyLabel,
        ], cwd);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
      const created = list(input.repository, marker);
      if (created.length !== 1) {
        throw new Error(
          `review child creation did not converge to one issue (observed ${created.length})`,
        );
      }
      return {
        number: created[0]!.number,
        url: created[0]!.html_url,
        findingKey: rendered.findingKey,
      };
    },
  };
}
