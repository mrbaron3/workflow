import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CanonicalRepository } from '../control-store/types.js';
import type { TriagePolicy } from './policy.js';
import { managedTriageLabels } from './policy.js';

const execFileAsync = promisify(execFile);
const Repository = CanonicalRepository;
const GitHubLabel = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);
const GitHubLabelObject = z.object({
  name: z.string().min(1).max(100),
}).passthrough();
const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  updated_at: z.string().datetime({ offset: true }),
  html_url: z.string().url(),
  labels: z.array(GitHubLabel),
  user: z.object({ login: z.string() }).passthrough(),
  pull_request: z.unknown().optional(),
}).passthrough();
const GitHubComment = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  updated_at: z.string().datetime({ offset: true }),
  html_url: z.string().url(),
  user: z.object({ login: z.string() }).passthrough(),
}).passthrough();
const GitHubRepository = z.object({
  default_branch: z.string().min(1),
}).passthrough();
const GitHubContent = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string(),
  size: z.number().int().nonnegative().max(128 * 1024),
}).passthrough();
const GitHubUser = z.object({ login: z.string().min(1) }).passthrough();

export interface TriageIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  updatedAt: string;
  url: string;
  labels: string[];
  author: string;
  isPullRequest: boolean;
}

export interface TriageComment {
  id: number;
  body: string;
  updatedAt: string;
  url: string;
  author: string;
}

export interface TriageRepositoryContext {
  documents: Array<{ path: string; content: string }>;
  openIssues: Array<{ number: number; title: string; labels: string[] }>;
}

export interface TriageSnapshot {
  actorLogin: string;
  issue: TriageIssue;
  comments: TriageComment[];
}

export interface TriageGitHub {
  snapshot(repository: string, issueNumber: number): Promise<TriageSnapshot>;
  repositoryContext(
    repository: string,
    issueNumber: number,
    paths: readonly string[],
  ): Promise<TriageRepositoryContext>;
  ensureManagedLabels(repository: string, policy: TriagePolicy): Promise<void>;
  applyManagedLabel(
    repository: string,
    issueNumber: number,
    desiredLabel: string,
    policy: TriagePolicy,
  ): Promise<string[]>;
  createComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string>;
}

export interface GhCommandResult {
  stdout: string;
}

export type GhCommand = (
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBufferBytes: number;
  },
) => Promise<GhCommandResult>;

export class TriageGitHubOperationError extends Error {
  constructor(
    operation: string,
    readonly status: number | null,
  ) {
    super(`typed GitHub ${operation} failed`);
  }
}

function errorHttpStatus(error: unknown): number | null {
  const values: string[] = [];
  if (error instanceof Error) values.push(error.message);
  if (error && typeof error === 'object') {
    for (const key of ['stderr', 'stdout']) {
      const value = Reflect.get(error, key);
      if (typeof value === 'string') values.push(value);
      else if (Buffer.isBuffer(value)) values.push(value.toString('utf8'));
    }
  }
  for (const value of values) {
    const match = /\bHTTP\s+([1-5][0-9]{2})\b/i.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

const defaultGhCommand: GhCommand = async (args, options) => {
  const result = await execFileAsync('gh', [...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    killSignal: 'SIGKILL',
    env: options.env,
  });
  return { stdout: result.stdout };
};

function endpoint(repository: string, suffix: string): string {
  return `/repos/${Repository.parse(repository)}${suffix}`;
}

function labelsOf(value: z.infer<typeof GitHubIssue>): string[] {
  return value.labels.map((label) =>
    typeof label === 'string' ? label : label.name);
}

function parsedJSON<T>(
  schema: z.ZodType<T>,
  raw: string,
  operation: string,
): T {
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) {
    throw new Error(`${operation} exceeded the response limit`);
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`${operation} returned an invalid response`);
  }
}

export class TypedGhTriageClient implements TriageGitHub {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    githubToken: string,
    private readonly run: GhCommand = defaultGhCommand,
  ) {
    if (githubToken.trim().length < 20) {
      throw new Error('triage GitHub credential is missing');
    }
    this.env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/agentops',
      GH_TOKEN: githubToken,
      GITHUB_TOKEN: githubToken,
      ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
    };
  }

  private async api(
    args: readonly string[],
    operation: string,
    limits: { timeoutMs?: number; maxBufferBytes?: number } = {},
  ): Promise<string> {
    try {
      return (await this.run(
        [
          'api',
          '--header', 'Accept: application/vnd.github+json',
          '--header', 'X-GitHub-Api-Version: 2022-11-28',
          ...args,
        ],
        {
          env: this.env,
          timeoutMs: limits.timeoutMs ?? 30_000,
          maxBufferBytes: limits.maxBufferBytes ?? 8 * 1024 * 1024,
        },
      )).stdout;
    } catch (error) {
      throw new TriageGitHubOperationError(
        operation,
        errorHttpStatus(error),
      );
    }
  }

  async snapshot(
    repository: string,
    issueNumber: number,
  ): Promise<TriageSnapshot> {
    const safeRepository = Repository.parse(repository);
    const safeNumber = z.number().int().positive().parse(issueNumber);
    const [actorRaw, issueRaw, commentsRaw] = await Promise.all([
      this.api(['/user'], 'current-user'),
      this.api(
        [endpoint(safeRepository, `/issues/${safeNumber}`)],
        'issue-read',
      ),
      this.api(
        [
          '--paginate',
          '--slurp',
          endpoint(
            safeRepository,
            `/issues/${safeNumber}/comments?per_page=100`,
          ),
        ],
        'comment-read',
      ),
    ]);
    const actor = parsedJSON(GitHubUser, actorRaw, 'current-user');
    const issue = parsedJSON(GitHubIssue, issueRaw, 'issue-read');
    const commentPages = parsedJSON(
      z.array(z.array(GitHubComment)).max(10),
      commentsRaw,
      'comment-read',
    );
    const comments = commentPages.flat();
    if (comments.length > 1_000) {
      throw new Error('comment-read exceeded the item limit');
    }
    return {
      actorLogin: actor.login,
      issue: {
        number: issue.number,
        title: issue.title.slice(0, 2_000),
        body: (issue.body ?? '').slice(0, 64 * 1024),
        state: issue.state,
        updatedAt: new Date(issue.updated_at).toISOString(),
        url: issue.html_url,
        labels: labelsOf(issue),
        author: issue.user.login,
        isPullRequest: issue.pull_request !== undefined,
      },
      comments: comments.map((comment) => ({
        id: comment.id,
        body: (comment.body ?? '').slice(0, 32 * 1024),
        updatedAt: new Date(comment.updated_at).toISOString(),
        url: comment.html_url,
        author: comment.user.login,
      })),
    };
  }

  async repositoryContext(
    repository: string,
    issueNumber: number,
    paths: readonly string[],
  ): Promise<TriageRepositoryContext> {
    const safeRepository = Repository.parse(repository);
    const repositoryRaw = await this.api(
      [endpoint(safeRepository, '')],
      'repository-read',
    );
    const metadata = parsedJSON(
      GitHubRepository,
      repositoryRaw,
      'repository-read',
    );
    const documents: TriageRepositoryContext['documents'] = [];
    let totalBytes = 0;
    for (const candidate of paths) {
      const encodedPath = candidate.split('/').map(encodeURIComponent).join('/');
      try {
        const raw = await this.api(
          [
            endpoint(
              safeRepository,
              `/contents/${encodedPath}?ref=${encodeURIComponent(metadata.default_branch)}`,
            ),
          ],
          'context-read',
          { maxBufferBytes: 256 * 1024 },
        );
        const content = parsedJSON(GitHubContent, raw, 'context-read');
        const decoded = Buffer.from(
          content.content.replaceAll('\n', ''),
          'base64',
        ).toString('utf8');
        totalBytes += Buffer.byteLength(decoded, 'utf8');
        if (totalBytes > 256 * 1024) {
          throw new Error('repository context exceeded the aggregate limit');
        }
        documents.push({ path: candidate, content: decoded });
      } catch (error) {
        if (
          error instanceof TriageGitHubOperationError
          && error.status === 404
        ) {
          continue;
        }
        throw error;
      }
    }
    const issuesRaw = await this.api(
      [
        endpoint(
          safeRepository,
          '/issues?state=open&sort=updated&direction=desc&per_page=100',
        ),
      ],
      'open-issue-read',
    );
    const openIssues = parsedJSON(
      z.array(GitHubIssue).max(100),
      issuesRaw,
      'open-issue-read',
    ).filter((issue) =>
      issue.pull_request === undefined && issue.number !== issueNumber);
    return {
      documents,
      openIssues: openIssues.map((issue) => ({
        number: issue.number,
        title: issue.title.slice(0, 2_000),
        labels: labelsOf(issue),
      })),
    };
  }

  async ensureManagedLabels(
    repository: string,
    policy: TriagePolicy,
  ): Promise<void> {
    const raw = await this.api(
      [
        '--paginate',
        '--slurp',
        endpoint(repository, '/labels?per_page=100'),
      ],
      'label-list',
    );
    const pages = parsedJSON(
      z.array(z.array(GitHubLabelObject)).max(10),
      raw,
      'label-list',
    );
    const labels = pages.flat();
    if (labels.length > 1_000) {
      throw new Error('label-list exceeded the item limit');
    }
    const existing = new Set(labels.map((label) => label.name));
    const definitions = [
      {
        name: policy.readyCandidateLabel,
        color: '1D76DB',
        description: 'AgentOps candidate awaiting human ready approval',
      },
      {
        name: policy.blockedLabel,
        color: 'B60205',
        description: 'Blocked by a recorded dependency or prerequisite',
      },
      {
        name: policy.needsInfoLabel,
        color: 'FBCA04',
        description: 'More product information is required before development',
      },
    ];
    for (const definition of definitions) {
      if (!existing.has(definition.name)) {
        await this.api(
          [
            '--method', 'POST',
            endpoint(repository, '/labels'),
            '-f', `name=${definition.name}`,
            '-f', `color=${definition.color}`,
            '-f', `description=${definition.description}`,
          ],
          'label-create',
        );
      }
    }
  }

  async applyManagedLabel(
    repository: string,
    issueNumber: number,
    desiredLabel: string,
    policy: TriagePolicy,
  ): Promise<string[]> {
    const managed = managedTriageLabels(policy);
    if (!managed.includes(desiredLabel)) {
      throw new Error('desired label is outside the triage policy');
    }
    const raw = await this.api(
      [
        '--method', 'POST',
        endpoint(repository, `/issues/${issueNumber}/labels`),
        '-f', `labels[]=${desiredLabel}`,
      ],
      'label-add',
    );
    const current = new Set(parsedJSON(
      z.array(GitHubLabelObject).max(1_000),
      raw,
      'label-add',
    ).map((label) => label.name));
    for (const label of managed) {
      if (label === desiredLabel || !current.has(label)) continue;
      await this.api(
        [
          '--method', 'DELETE',
          endpoint(
            repository,
            `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
          ),
        ],
        'label-remove',
      );
    }
    return [desiredLabel];
  }

  async createComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string> {
    if (body.length < 1 || body.length > 60_000) {
      throw new Error('triage comment exceeds the bounded body size');
    }
    const raw = await this.api(
      [
        '--method', 'POST',
        endpoint(repository, `/issues/${issueNumber}/comments`),
        '-f', `body=${body}`,
      ],
      'comment-create',
    );
    return parsedJSON(GitHubComment, raw, 'comment-create').html_url;
  }
}

export const TRIAGE_MARKER_PREFIX = '<!-- agentops-triage:v1 ';

export function triageMarker(
  sourceDigest: string,
  readiness: string,
): string {
  return `${TRIAGE_MARKER_PREFIX}source-sha256=${sourceDigest} readiness=${readiness} -->`;
}

export function markerDigest(body: string): string | null {
  const match = body.match(
    /<!-- agentops-triage:v1 source-sha256=([0-9a-f]{64}) readiness=(?:ready_candidate|blocked|needs_info) -->/,
  );
  return match?.[1] ?? null;
}

export function triageSourceDigest(
  repository: string,
  snapshot: TriageSnapshot,
  policy: TriagePolicy,
): string {
  const managed = new Set(managedTriageLabels(policy));
  const comments = snapshot.comments
    .filter((comment) =>
      comment.author !== snapshot.actorLogin || markerDigest(comment.body) === null)
    .map((comment) => ({
      id: comment.id,
      body: comment.body,
      updatedAt: comment.updatedAt,
      author: comment.author,
    }));
  const source = {
    repository: Repository.parse(repository),
    issue: {
      number: snapshot.issue.number,
      title: snapshot.issue.title,
      body: snapshot.issue.body,
      state: snapshot.issue.state,
      author: snapshot.issue.author,
      labels: snapshot.issue.labels
        .filter((label) => !managed.has(label))
        .sort(),
    },
    comments,
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

export function hasTriageMarker(
  snapshot: TriageSnapshot,
  digest: string,
): TriageComment | null {
  return snapshot.comments.find((comment) =>
    comment.author === snapshot.actorLogin
    && markerDigest(comment.body) === digest) ?? null;
}
