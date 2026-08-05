import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CanonicalRepository,
  GitHubLabelNameContract,
} from '../control-store/types.js';
import { runCommand } from '../pipeline/execution/command.js';

const Comment = z.object({
  body: z.string().nullable(),
  html_url: z.string().url(),
}).passthrough();
const Issue = z.object({
  labels: z.array(z.union([
    z.string(),
    z.object({ name: z.string() }).passthrough(),
  ])),
}).passthrough();

export const PLANNING_HUMAN_REVIEW_MARKER_PREFIX =
  '<!-- agentops-planning-human-review:v1 ';

export interface ManagedPlanningHumanReviewComment {
  marker: string;
  body: string;
}

export interface PlanningHumanReviewGitHub {
  ensureManagedComment(
    repository: string,
    issueNumber: number,
    comment: ManagedPlanningHumanReviewComment,
  ): string;
  removeClaimedLabel(
    repository: string,
    issueNumber: number,
    claimedLabel: string,
  ): void;
}

export type PlanningHumanReviewCommand = (args: readonly string[]) => string;

function issueEndpoint(
  repository: string,
  issueNumber: number,
  suffix = '',
): string {
  return `/repos/${CanonicalRepository.parse(repository)}/issues/${
    z.number().int().positive().parse(issueNumber)
  }${suffix}`;
}

function parsedJSON<T>(
  schema: z.ZodType<T>,
  raw: string,
  operation: string,
): T {
  if (Buffer.byteLength(raw, 'utf8') > 32 * 1024 * 1024) {
    throw new Error(`${operation} exceeded the response limit`);
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`${operation} returned an invalid response`);
  }
}

function longestBacktickRun(values: readonly string[]): number {
  let longest = 0;
  for (const value of values) {
    for (const match of value.matchAll(/`+/g)) {
      longest = Math.max(longest, match[0].length);
    }
  }
  return longest;
}

/**
 * Render only recorded planning-gate reasons inside the evidence block. The
 * surrounding copy is deterministic and explicitly keeps ready approval with
 * a human.
 */
export function renderPlanningHumanReviewComment(input: {
  repository: string;
  issueNumber: number;
  reasons: readonly string[];
  readyLabel: string;
}): ManagedPlanningHumanReviewComment {
  const repository = CanonicalRepository.parse(input.repository);
  const issueNumber = z.number().int().positive().parse(input.issueNumber);
  const readyLabel = GitHubLabelNameContract.parse(input.readyLabel);
  if (input.reasons.length === 0 || input.reasons.some((reason) => reason.length === 0)) {
    throw new Error('planning human review requires recorded non-empty reasons');
  }
  const reasons = [...input.reasons];
  const digest = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    repository,
    issueNumber,
    reasons,
  })).digest('hex');
  const marker =
    `${PLANNING_HUMAN_REVIEW_MARKER_PREFIX}sha256=${digest} -->`;
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(reasons) + 1));
  const recordedReasons = reasons
    .map((reason, index) => `${index + 1}. ${reason}`)
    .join('\n\n');
  const body = [
    marker,
    '### AgentOps planning: 人間の判断待ち',
    '',
    'planning gate は、次の未解決点について人間の WHAT 判断を待っています。',
    '以下の evidence block は、planning enrichment に記録された停止理由だけをそのまま転記しています。',
    '',
    `${fence}text`,
    recordedReasons,
    fence,
    '',
    'これは HOW への人間介入でも provider 障害でもなく、WHAT の判断点です。',
    `AgentOps はこの停止では \`${readyLabel}\` を付けません。Issue の WHAT を補い、`,
    '人間が再開を判断した場合にだけ ready signal を付けてください。',
  ].join('\n');
  if (body.length > 60_000) {
    throw new Error('planning human-review comment exceeds the bounded body size');
  }
  return { marker, body };
}

/**
 * The runner uses only Issue-comment creation and claimed-label removal here:
 * both are within the existing triage permission envelope, and there is no
 * operation capable of adding the human-owned ready label.
 */
export function realPlanningHumanReviewGitHub(
  cwd: string,
  command: PlanningHumanReviewCommand = (args) =>
    runCommand('gh', [...args], cwd),
): PlanningHumanReviewGitHub {
  return {
    ensureManagedComment(repository, issueNumber, comment) {
      if (
        !/^<!-- agentops-planning-human-review:v1 sha256=[0-9a-f]{64} -->$/
          .test(comment.marker)
        || !comment.body.startsWith(`${comment.marker}\n`)
        || comment.body.length > 60_000
      ) {
        throw new Error('planning human-review comment is not managed or bounded');
      }
      const endpoint = issueEndpoint(repository, issueNumber, '/comments');
      const pages = parsedJSON(
        z.array(z.array(Comment)).max(10),
        command([
          'api',
          '--paginate',
          '--slurp',
          `${endpoint}?per_page=100`,
        ]),
        'planning comment list',
      );
      const comments = pages.flat();
      if (comments.length > 1_000) {
        throw new Error('planning comment list exceeded the item limit');
      }
      const existing = comments.find((candidate) =>
        candidate.body?.startsWith(`${comment.marker}\n`));
      if (existing) return existing.html_url;
      const created = parsedJSON(
        Comment,
        command([
          'api',
          '--method',
          'POST',
          endpoint,
          '-f',
          `body=${comment.body}`,
        ]),
        'planning comment create',
      );
      return created.html_url;
    },

    removeClaimedLabel(repository, issueNumber, claimedLabel) {
      const label = GitHubLabelNameContract.parse(claimedLabel);
      const endpoint = issueEndpoint(repository, issueNumber);
      const issue = parsedJSON(
        Issue,
        command(['api', endpoint]),
        'planning issue read',
      );
      const labels = issue.labels.map((candidate) =>
        typeof candidate === 'string' ? candidate : candidate.name);
      if (!labels.includes(label)) return;
      command([
        'api',
        '--method',
        'DELETE',
        `${endpoint}/labels/${encodeURIComponent(label)}`,
      ]);
    },
  };
}
