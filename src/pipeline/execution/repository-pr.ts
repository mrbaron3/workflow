/**
 * Repository-wide PR intake.
 *
 * A repository registration is the control-plane boundary: operators never register
 * individual PRs. Every open, same-repository PR targeting the configured base is
 * discovered on each GitHub turn, projected into the durable Store, and reviewed at
 * its current head. PRs created by the Issue pipeline are deduplicated by external
 * PR number and continue through their original work-unit flow.
 */

import path from 'node:path';
import type { HarnessConfig } from '../../config.js';
import { resolvedGeneratorProvider } from '../../agents/routing.js';
import { recordAgentInvocation } from '../../agents/invocation.js';
import {
  Issue,
  PR,
  type Issue as IssueType,
  type PR as PRType,
  type PrRevision,
} from '../../domain/schema.js';
import { Store, nowISO } from '../../store/store.js';
import { gradeBuild, hasBlockingGateFailure } from '../../graders/index.js';
import { groundArtifact } from './grade.js';
import { applyPanelVerdict } from './loop.js';
import { PERSPECTIVES, runPanel, type PerspectiveSpec } from '../panel.js';
import {
  runPerspectiveSessions,
  sessionBackedGrader,
} from './perspective-session.js';
import {
  createDetachedWorktree,
  removeWorktree,
} from './worktree.js';
import {
  observePrRevision,
  type GithubOpenPullRequest,
  type PrNativeGithubRunner,
} from './pr-native.js';

export interface RepositoryPullRequestDiscovery {
  pullRequest: GithubOpenPullRequest;
  pr: PRType;
  issue: IssueType;
  revision: PrRevision;
  imported: boolean;
  reviewRequired: boolean;
}

export interface RepositoryPullRequestReviewResult {
  prId: string;
  revisionId: string;
  headSha: string;
  verdict: 'approve' | 'request_changes' | 'needs_human';
}

export type RepositoryPullRequestReviewer = (
  discovery: RepositoryPullRequestDiscovery,
) => Promise<RepositoryPullRequestReviewResult | null>;

function syntheticContract(pullRequest: GithubOpenPullRequest) {
  const statedIntent = pullRequest.body.trim().slice(0, 12_000);
  return {
    productGoal: pullRequest.title,
    userStory: [
      `As a repository maintainer, I want PR #${pullRequest.number} reviewed against`,
      `its stated intent, repository rules, and regression gates before merge.`,
    ].join(' '),
    scope: { include: [], exclude: [] },
    acceptanceCriteria: [{
      id: 'PR-INTENT',
      severity: 'blocker' as const,
      behavior: statedIntent
        ? [
            `Review the complete diff origin/${pullRequest.baseRefName}...${pullRequest.headSha}.`,
            pullRequest.title,
            statedIntent,
          ].join('\n\n')
        : [
            `Review the complete diff origin/${pullRequest.baseRefName}...${pullRequest.headSha}.`,
            pullRequest.title,
          ].join('\n\n'),
      verification: {
        method: 'scope_check' as const,
        expected: [
          'the implementation matches the PR title and body',
          'configured deterministic graders pass',
          'every required review perspective approves the current head',
        ],
      },
    }],
    redLines: [
      'Do not merge evidence produced for another head SHA.',
      'Do not let an approve verdict mask a blocker or major finding.',
    ],
  };
}

function createRepositoryReviewIssue(
  store: Store,
  config: HarnessConfig,
  pullRequest: GithubOpenPullRequest,
): IssueType {
  const timestamp = nowISO();
  return store.addIssue(Issue.parse({
    id: store.nextId('ISSUE'),
    type: 'tech-debt',
    title: `PR #${pullRequest.number}: ${pullRequest.title}`,
    area: 'fullstack',
    status: 'ready-for-evaluation',
    assignedAgent: resolvedGeneratorProvider(config),
    contract: syntheticContract(pullRequest),
    implementationNotes: [
      `Repository-discovered GitHub PR: ${pullRequest.url}`,
      `Original head branch: ${pullRequest.headRefName}`,
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

function currentRevisionAttempted(
  store: Store,
  pr: PRType,
  revision: PrRevision,
): boolean {
  return store.db.evalRuns.some(
    (run) => run.prId === pr.id
      && run.revisionId === revision.id
      && run.headSha === revision.headSha,
  ) || store.db.agentInvocations.some(
    (invocation) => invocation.prId === pr.id
      && invocation.revisionId === revision.id
      && invocation.headSha === revision.headSha,
  );
}

/**
 * Upsert every eligible open PR from the registered repository. The production
 * runner lists GitHub; test doubles may omit discovery and retain legacy behavior.
 */
export function discoverRepositoryPullRequests(
  store: Store,
  config: HarnessConfig,
  runner: PrNativeGithubRunner,
  cwd: string,
): RepositoryPullRequestDiscovery[] {
  if (!runner.listOpenPullRequests) return [];
  const baseBranch = config.gate?.baseBranch ?? config.baseBranch;
  const pullRequests = runner.listOpenPullRequests(cwd, baseBranch)
    .filter((pullRequest) =>
      !pullRequest.isCrossRepository
      && pullRequest.baseRefName === baseBranch);
  const discoveries: RepositoryPullRequestDiscovery[] = [];

  for (const pullRequest of pullRequests) {
    let pr = store.db.prs.find(
      (candidate) => candidate.externalRef?.provider === 'github'
        && candidate.externalRef.number === pullRequest.number,
    );
    let imported = false;
    if (!pr) {
      const issue = createRepositoryReviewIssue(store, config, pullRequest);
      const timestamp = nowISO();
      pr = store.addPR(PR.parse({
        id: store.nextId('PR'),
        issueId: issue.id,
        branch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        generator: resolvedGeneratorProvider(config),
        origin: 'repository-discovery',
        attempts: 0,
        status: 'open',
        externalRef: {
          provider: 'github',
          number: pullRequest.number,
          url: pullRequest.url,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      imported = true;
    }

    const issue = store.requireIssue(pr.issueId);
    const revision = observePrRevision(store, pr, pullRequest.headSha);
    discoveries.push({
      pullRequest,
      pr,
      issue,
      revision,
      imported,
      reviewRequired: pr.origin === 'repository-discovery'
        && !currentRevisionAttempted(store, pr, revision),
    });
  }

  if (discoveries.length > 0) store.save();
  return discoveries;
}

function enterRepositoryPrEvaluation(store: Store, issue: IssueType): void {
  if (issue.status === 'evaluation-in-progress') return;
  if (issue.status === 'changes-requested') {
    store.setStatus(issue.id, 'generation-in-progress');
  }
  if (issue.status === 'generation-in-progress') {
    store.setStatus(issue.id, 'ready-for-evaluation');
  }
  if (issue.status === 'build-approved') {
    store.setStatus(issue.id, 'needs-human-review');
  }
  if (issue.status === 'needs-human-review') {
    store.setStatus(issue.id, 'ready-for-evaluation');
  }
  if (issue.status !== 'ready-for-evaluation') {
    throw new Error(
      `${issue.id} cannot enter repository PR review from status ${issue.status}`,
    );
  }
  store.setStatus(issue.id, 'evaluation-in-progress');
}

function attemptForRevision(
  store: Store,
  pr: PRType,
  revision: PrRevision,
): number {
  const recorded = [
    ...store.db.evalRuns
      .filter((run) => run.prId === pr.id && run.revisionId === revision.id)
      .map((run) => run.attempt),
    ...store.db.agentInvocations
      .filter((invocation) =>
        invocation.prId === pr.id && invocation.revisionId === revision.id)
      .map((invocation) => invocation.attempt),
  ];
  return recorded.length > 0 ? Math.max(...recorded) : pr.attempts + 1;
}

/**
 * Review one repository-discovered current head without regenerating it first.
 * A request_changes result places its synthetic work unit on the ordinary repair
 * queue; that queue then amends the same remote PR branch.
 */
export async function reviewRepositoryPullRequest(
  store: Store,
  config: HarnessConfig,
  discovery: RepositoryPullRequestDiscovery,
  runner: PrNativeGithubRunner,
  harnessRoot: string,
  log: (message: string) => void = () => {},
  perspectives: PerspectiveSpec[] = PERSPECTIVES,
): Promise<RepositoryPullRequestReviewResult | null> {
  if (!discovery.reviewRequired) return null;
  if (!config.target) throw new Error('repository PR review requires config.target');
  if (!runner.fetchPullRequestHead || !runner.pullRequestChangedFiles) {
    throw new Error('repository PR discovery runner cannot fetch or diff pull request heads');
  }

  const { pullRequest, pr, issue, revision } = discovery;
  runner.fetchPullRequestHead(
    path.resolve(harnessRoot, config.target.repo),
    pullRequest.number,
    revision.headSha,
    pullRequest.headRefName,
    pullRequest.baseRefName,
  );
  const repo = path.resolve(harnessRoot, config.target.repo);
  const issueKey = `repository-pr-${pullRequest.number}-r${revision.ordinal}`;
  const worktree = path.join(harnessRoot, '.harness', 'worktrees', issueKey);
  createDetachedWorktree(repo, revision.headSha, worktree);

  try {
    enterRepositoryPrEvaluation(store, issue);
    const attempt = attemptForRevision(store, pr, revision);
    pr.attempts = Math.max(pr.attempts, attempt);
    revision.status = 'reviewing';
    store.save();

    const changed = runner.pullRequestChangedFiles(repo, pullRequest.number);
    const artifact = groundArtifact({
      contract: issue.contract!,
      target: config.target,
      worktree,
      branch: pr.branch,
      changed,
    });
    const deterministicGrade = gradeBuild(issue.contract!, artifact, config);
    const invocationKeys: Record<string, string> = {};
    let evalRoot = path.join(worktree, '.agentops', 'eval');

    if (!hasBlockingGateFailure(deterministicGrade.hardGates)) {
      const panelSessions = await runPerspectiveSessions(
        config,
        {
          worktree,
          contract: issue.contract!,
          perspectives,
          issueKey,
          repo,
          buildRef: revision.headSha,
          uiDesign: issue.uiDesign,
        },
        log,
      );
      evalRoot = panelSessions.evalRoot;
      for (const invocation of panelSessions.invocations) {
        const record = recordAgentInvocation(store, {
          subjectId: issue.id,
          issueId: issue.id,
          prId: pr.id,
          sampleIndex: 0,
          attempt,
          ...invocation,
          revisionId: revision.id,
          headSha: revision.headSha,
        });
        invocationKeys[invocation.perspective] = record.invocationKey;
      }
    }

    const panel = runPanel(
      store,
      config,
      {
        issueId: issue.id,
        prId: pr.id,
        contract: issue.contract!,
        artifact,
        sampleIndex: 0,
        attempt,
        agent: pr.generator,
        invocationKeys,
        revisionId: revision.id,
        headSha: revision.headSha,
        featureArea: issue.area,
      },
      { perspectives, grader: sessionBackedGrader(evalRoot) },
    );

    if (!panel.escalated) applyPanelVerdict(store, issue.id, panel.verdict);
    pr.status = panel.verdict === 'approve' ? 'approved' : 'changes-requested';
    revision.status = panel.verdict === 'approve'
      ? 'reviewing'
      : panel.verdict === 'request_changes'
        ? 'changes-requested'
        : 'failed';
    revision.completedAt = panel.verdict === 'approve' ? null : nowISO();
    pr.updatedAt = nowISO();
    store.save();
    log(
      `  ✓ ${pr.id}: repository PR #${pullRequest.number} `
      + `${revision.headSha.slice(0, 12)} reviewed → ${panel.verdict}`,
    );
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      verdict: panel.verdict,
    };
  } finally {
    removeWorktree(path.resolve(harnessRoot, config.target.repo), worktree);
  }
}
