import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HarnessConfig } from '../config.js';
import type { TargetGraderConfig } from '../config.js';
import { DEFAULT_CONFIG } from '../config.js';
import { Store } from '../store/store.js';
import {
  runGithubDevelopmentTurn,
  type GithubDevelopmentTurnResult,
} from '../intake/development-turn.js';
import {
  realGithubIssueRunner,
  type GithubIssueRunner,
} from '../intake/github-issues.js';
import { runPlanningSession } from '../intake/planning-session.js';
import { runUiDesignSession } from '../intake/ui-design-session.js';
import { runGeneratorSession } from '../pipeline/execution/session.js';
import { groundArtifact } from '../pipeline/execution/grade.js';
import {
  runPerspectiveSessions,
} from '../pipeline/execution/perspective-session.js';
import type { LiveOptions } from '../pipeline/execution/live.js';
import {
  realGhGateRunner,
  type GhGateRunner,
} from '../pipeline/execution/gate.js';
import {
  realPrNativeGithubRunner,
  type PrNativeGithubRunner,
} from '../pipeline/execution/pr-native.js';
import type {
  Lease,
  RunnerJobPayloadV1,
} from '../control-store/types.js';
import type { PR } from '../domain/schema.js';
import {
  realPlanningHumanReviewGitHub,
  renderPlanningHumanReviewComment,
  type PlanningHumanReviewGitHub,
} from '../triage/planning-human-review.js';
import { RunnerExecutionError } from './errors.js';
import type { RunnerLeaseFence } from './guard.js';
import { isolatedGraderEnvironment } from './security.js';
import type { PreparedRunnerWorkspace } from './workspace.js';

interface AgentOpsAdapterResultBase {
  headSha: string | null;
  pullRequestNumber: number | null;
  developmentTurn: GithubDevelopmentTurnResult;
}

export type AgentOpsAdapterResult = AgentOpsAdapterResultBase & (
  | {
    outcome: 'completed';
    humanReview: null;
  }
  | {
    outcome: 'needs-human-review';
    humanReview: {
      issueNumber: number;
      reasons: string[];
      commentUrl: string;
    };
  }
);

export interface AgentOpsAdapterInput {
  lease: Lease;
  payload: RunnerJobPayloadV1;
  workspace: PreparedRunnerWorkspace;
  fence: RunnerLeaseFence;
  provider: 'codex' | 'claude';
  log: (message: string) => void;
}

export interface AgentOpsRunnerAdapter {
  execute(input: AgentOpsAdapterInput): Promise<AgentOpsAdapterResult>;
}

export interface ExistingAgentOpsAdapterDependencies {
  issueRunner?: (cwd: string) => GithubIssueRunner;
  gateRunner?: (repository: string) => GhGateRunner;
  prNativeRunner?: (
    mergeMethod: 'squash' | 'merge' | 'rebase',
    repository: string,
  ) => PrNativeGithubRunner;
  planningRunner?: typeof runPlanningSession;
  uiDesignRunner?: typeof runUiDesignSession;
  generatorSession?: typeof runGeneratorSession;
  perspectiveSessions?: typeof runPerspectiveSessions;
  groundBuild?: LiveOptions['groundBuild'];
  planningHumanReviewGithub?: (cwd: string) => PlanningHumanReviewGitHub;
}

/**
 * A current immutable head that already has durable request-changes evidence
 * is a completed PR-event review, not a transient reconciliation failure.
 * Reconciliation can project the PR/revision back to open/reviewing when other
 * perspective evidence is intentionally absent after a deterministic veto, so
 * the revision-bound EvalRun is the fallback source of truth.
 */
export function hasDurableCurrentHeadRequestChanges(
  store: Store,
  pr: PR,
): boolean {
  if (pr.headSha === null || pr.currentRevisionId === null) return false;
  const revision = store.revisionForHead(pr.id, pr.headSha);
  if (!revision || revision.id !== pr.currentRevisionId) return false;
  if (
    pr.status === 'changes-requested'
    || revision.status === 'changes-requested'
  ) {
    return true;
  }
  return store.db.evalRuns.some((run) =>
    run.prId === pr.id
    && run.revisionId === revision.id
    && run.headSha === revision.headSha
    && run.verdict === 'request_changes');
}

function baseBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

interface NodePackageManifest {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/**
 * Select a bounded grader profile from repository-owned, immutable-at-claim
 * metadata. Repository identity is intentionally irrelevant. We support the
 * existing TypeScript/Vitest profile and a dependency-backed Node contract
 * checker expressed as one direct `node relative/script` command. Shell
 * operators, package-manager installs, and arbitrary job-supplied commands are
 * never accepted.
 */
export function inferRepositoryGraders(
  worktreePath: string,
): TargetGraderConfig {
  const manifestPath = path.join(worktreePath, 'package.json');
  let manifest: NodePackageManifest;
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error('package manifest is not a bounded regular file');
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as NodePackageManifest;
  } catch {
    throw new RunnerExecutionError(
      'workspace_failure',
      'registered repository has no supported bounded grader profile',
      false,
    );
  }
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  if ('typescript' in dependencies && 'vitest' in dependencies) {
    return {
      typecheck: 'node /app/node_modules/typescript/bin/tsc --noEmit',
      unit_tests: 'node /app/node_modules/vitest/vitest.mjs run --configLoader runner',
      commands: {
        build: 'node /app/node_modules/typescript/bin/tsc',
        typecheck: 'node /app/node_modules/typescript/bin/tsc --noEmit',
        unit_test: 'node /app/node_modules/vitest/vitest.mjs run --configLoader runner',
      },
    };
  }
  const testScript = manifest.scripts?.test;
  const match = typeof testScript === 'string'
    ? /^node ([A-Za-z0-9._/-]+\.(?:mjs|cjs|js))$/.exec(testScript.trim())
    : null;
  if (match) {
    const relativeScript = match[1]!;
    if (
      relativeScript.split('/').some((segment) =>
        segment === '' || segment === '.' || segment === '..')
    ) {
      throw new RunnerExecutionError(
        'workspace_failure',
        'repository contract checker path is unsafe',
        false,
      );
    }
    const scriptPath = path.resolve(worktreePath, relativeScript);
    if (
      !scriptPath.startsWith(`${path.resolve(worktreePath)}${path.sep}`)
      || !fs.existsSync(scriptPath)
      || !fs.statSync(scriptPath).isFile()
    ) {
      throw new RunnerExecutionError(
        'workspace_failure',
        'repository contract checker is absent',
        false,
      );
    }
    const command = `node ${relativeScript}`;
    return {
      typecheck: command,
      commands: {
        build: command,
        typecheck: command,
        api_test: command,
        db_state_check: command,
      },
    };
  }
  throw new RunnerExecutionError(
    'workspace_failure',
    'registered repository has no supported bounded grader profile',
    false,
  );
}

export function repositoryGraderProfileEvidence(
  worktreePath: string,
  claimedProfile: TargetGraderConfig,
): {
  graderProfileValid: boolean;
  graderProfileError?: string;
} {
  let observedProfile: TargetGraderConfig;
  try {
    observedProfile = inferRepositoryGraders(worktreePath);
  } catch (error) {
    return {
      graderProfileValid: false,
      graderProfileError:
        `built checkout has no supported bounded profile: `
        + `${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isDeepStrictEqual(observedProfile, claimedProfile)) {
    return {
      graderProfileValid: false,
      graderProfileError:
        `built checkout profile differs from the claimed profile `
        + `(claimed=${JSON.stringify(claimedProfile)}, `
        + `observed=${JSON.stringify(observedProfile)})`,
    };
  }
  return { graderProfileValid: true };
}

function scopedIssueRunner(
  fence: RunnerLeaseFence,
  delegate: GithubIssueRunner,
  issueNumber: number,
): GithubIssueRunner {
  return {
    listReadyIssues(repository, readyLabel) {
      return delegate
        .listReadyIssues(repository, readyLabel)
        .filter((issue) => issue.number === issueNumber);
    },
    claimIssue(repository, number, readyLabel, claimedLabel) {
      if (number !== issueNumber) {
        throw new RunnerExecutionError(
          'provider_failure',
          `runner job cannot claim unexpected issue #${number}`,
          false,
          'provider',
        );
      }
      fence.consume('claim');
      delegate.claimIssue(repository, number, readyLabel, claimedLabel);
    },
  };
}

function guardedGateRunner(
  fence: RunnerLeaseFence,
  delegate: GhGateRunner,
): GhGateRunner {
  return {
    pushBranch(worktree, branch) {
      fence.consume('push');
      delegate.pushBranch(worktree, branch);
    },
    createPr(cwd, args) {
      fence.consume('push');
      return delegate.createPr(cwd, args);
    },
    viewPr: delegate.viewPr.bind(delegate),
  };
}

function guardedPrNativeRunner(
  fence: RunnerLeaseFence,
  delegate: PrNativeGithubRunner,
  allowedPullRequestNumber?: number,
): PrNativeGithubRunner {
  const assertPullRequest = (number: number): void => {
    if (
      allowedPullRequestNumber !== undefined
      && number !== allowedPullRequestNumber
    ) {
      throw new RunnerExecutionError(
        'provider_failure',
        `runner job cannot operate on unexpected PR #${number}`,
        false,
        'provider',
      );
    }
  };
  return {
    viewRevision(cwd, prNumber) {
      assertPullRequest(prNumber);
      return delegate.viewRevision(cwd, prNumber);
    },
    merge(cwd, prNumber, expectedHeadSha) {
      assertPullRequest(prNumber);
      fence.consume('merge');
      delegate.merge(cwd, prNumber, expectedHeadSha);
    },
    closeIssue(cwd, repository, issueNumber) {
      fence.consume('release');
      delegate.closeIssue(cwd, repository, issueNumber);
    },
    ...(delegate.listOpenPullRequests
      ? {
          listOpenPullRequests(cwd, baseBranch) {
            return delegate.listOpenPullRequests!(cwd, baseBranch)
              .filter((pullRequest) =>
                allowedPullRequestNumber === undefined
                || pullRequest.number === allowedPullRequestNumber);
          },
        }
      : {}),
    ...(delegate.fetchPullRequestHead
      ? {
          fetchPullRequestHead(cwd, prNumber, expectedHeadSha, headRefName, baseRefName) {
            assertPullRequest(prNumber);
            return delegate.fetchPullRequestHead!(
              cwd,
              prNumber,
              expectedHeadSha,
              headRefName,
              baseRefName,
            );
          },
        }
      : {}),
    ...(delegate.pullRequestChangedFiles
      ? {
          pullRequestChangedFiles(cwd, prNumber) {
            assertPullRequest(prNumber);
            return delegate.pullRequestChangedFiles!(cwd, prNumber);
          },
        }
      : {}),
  };
}

function guardedPlanningHumanReviewGithub(
  fence: RunnerLeaseFence,
  delegate: PlanningHumanReviewGitHub,
  repository: string,
  issueNumber: number,
): PlanningHumanReviewGitHub {
  const assertScope = (
    requestedRepository: string,
    requestedIssueNumber: number,
  ): void => {
    if (
      requestedRepository !== repository
      || requestedIssueNumber !== issueNumber
    ) {
      throw new RunnerExecutionError(
        'provider_failure',
        `runner job cannot surface human review for unexpected Issue `
        + `${requestedRepository}#${requestedIssueNumber}`,
        false,
        'release',
      );
    }
  };
  return {
    ensureManagedComment(
      requestedRepository,
      requestedIssueNumber,
      comment,
    ) {
      assertScope(requestedRepository, requestedIssueNumber);
      fence.consume('release');
      return delegate.ensureManagedComment(
        requestedRepository,
        requestedIssueNumber,
        comment,
      );
    },
    removeClaimedLabel(
      requestedRepository,
      requestedIssueNumber,
      claimedLabel,
    ) {
      assertScope(requestedRepository, requestedIssueNumber);
      fence.consume('release');
      delegate.removeClaimedLabel(
        requestedRepository,
        requestedIssueNumber,
        claimedLabel,
      );
    },
  };
}

function runnerConfig(input: AgentOpsAdapterInput): HarnessConfig {
  const repository = `${input.payload.repository.owner}/${input.payload.repository.name}`;
  const branch = baseBranch(input.payload.target.baseRef);
  const route = { provider: input.provider };
  const systemDir = path.join(input.workspace.worktreePath, 'docs', '_system');
  return {
    ...DEFAULT_CONFIG,
    generator: input.provider,
    samples: 1,
    maxConcurrentIssues: 1,
    baseBranch: branch,
    target: {
      repo: input.workspace.worktreePath,
      baseRef: input.payload.target.baseRef,
      ...(fs.existsSync(systemDir) ? { systemDir } : {}),
      protectedPaths: ['.git', '.github/workflows'],
      graders: inferRepositoryGraders(input.workspace.worktreePath),
    },
    gate: {
      backend: 'github',
      baseBranch: branch,
      requiredChecks: input.payload.execution.requiredChecks,
      mergeMethod: input.payload.execution.mergeMethod,
    },
    intake: {
      backend: 'github',
      repository,
      readyLabel: input.payload.execution.readyLabel,
      claimedLabel: input.payload.execution.claimedLabel,
    },
    routes: {
      generator: route,
      planning: route,
      uiDesign: route,
      reviewer: route,
    },
  };
}

/**
 * Adapter onto the existing planning → generation → PR-native current-head
 * review/repair/test → expected-SHA merge → release path. The runner adds
 * fences at side-effect seams; it does not implement an alternate fast path.
 */
export class ExistingAgentOpsRunnerAdapter implements AgentOpsRunnerAdapter {
  constructor(
    private readonly dependencies: ExistingAgentOpsAdapterDependencies = {},
  ) {}

  async execute(input: AgentOpsAdapterInput): Promise<AgentOpsAdapterResult> {
    const event = input.payload.event;
    const repository =
      `${input.payload.repository.owner}/${input.payload.repository.name}`;
    process.env.AGENTOPS_RUNNER_REGISTRATION_ROOT =
      input.workspace.registrationRoot;
    const store = new Store(input.workspace.statePath);
    if (!Store.isInitialized(input.workspace.statePath)) store.save();
    const config = runnerConfig(input);
    const realIssueRunner = (
      this.dependencies.issueRunner ?? realGithubIssueRunner
    )(input.workspace.worktreePath);
    const issueRunner = input.payload.event.kind === 'issue'
      ? scopedIssueRunner(input.fence, realIssueRunner, input.payload.event.number)
      : {
          listReadyIssues: () => [],
          claimIssue: () => {
            throw new RunnerExecutionError(
              'provider_failure',
              'pull-request reconciliation cannot claim an Issue',
              false,
              'provider',
            );
          },
        };
    const planningHumanReviewGithub = input.payload.event.kind === 'issue'
      ? guardedPlanningHumanReviewGithub(
          input.fence,
          (
            this.dependencies.planningHumanReviewGithub
            ?? realPlanningHumanReviewGitHub
          )(input.workspace.worktreePath),
          repository,
          input.payload.event.number,
        )
      : null;
    const gateRunner = guardedGateRunner(
      input.fence,
      (this.dependencies.gateRunner ?? realGhGateRunner)(repository),
    );
    const prNativeRunner = guardedPrNativeRunner(
      input.fence,
      (
        this.dependencies.prNativeRunner ?? realPrNativeGithubRunner
      )(input.payload.execution.mergeMethod, repository),
      input.payload.event.kind === 'pull_request'
        ? input.payload.event.number
        : undefined,
    );
    const beforeProvider = (): Promise<void> => input.fence.arm('provider');
    const beforeMergeAndRelease = async (): Promise<void> => {
      await input.fence.arm('merge');
      await input.fence.arm('release');
      await input.fence.arm('release');
    };

    const developmentTurn = await runGithubDevelopmentTurn(
      store,
      config,
      {
        issueRunner,
        ...(input.payload.event.kind === 'issue'
          ? { beforeIssueClaim: () => input.fence.arm('claim') }
          : {}),
        planningRunner: async ({ intake, route }) => {
          await beforeProvider();
          return (this.dependencies.planningRunner ?? runPlanningSession)(
            config,
            intake,
            route,
            input.workspace.statePath,
            input.log,
          );
        },
        uiDesignRunner: async ({ intake, candidate, route }) => {
          await beforeProvider();
          return (this.dependencies.uiDesignRunner ?? runUiDesignSession)(
            config,
            intake,
            candidate,
            route,
            input.workspace.statePath,
            input.log,
          );
        },
        prNativeRunner,
        discoverPullRequests: input.payload.event.kind !== 'issue',
        // Issue jobs start from a fresh job-scoped store, so there is nothing
        // to reconcile before intake. PR/repository jobs arm permits only
        // immediately before their bounded reconciliation pass.
        beforeReconcile: input.payload.event.kind === 'issue'
          ? async () => {
              if (store.db.prs.some((pr) =>
                pr.externalRef !== null
                && pr.status !== 'merged'
                && pr.status !== 'closed')) {
                await beforeMergeAndRelease();
              }
            }
          : beforeMergeAndRelease,
        reconcileOptions: {
          beforeRelease: () => input.fence.consume('release'),
        },
        liveOptions: {
          gateRunner,
          prNativeRunner,
          beforeProviderExecution: beforeProvider,
          beforePush: () => input.fence.arm('push'),
          beforeCreatePr: () => input.fence.arm('push'),
          beforeMerge: () => input.fence.arm('merge'),
          beforeRelease: async () => {
            await input.fence.arm('release');
            await input.fence.arm('release');
          },
          assertReleasePermit: () => input.fence.consume('release'),
          graderEnvironment: isolatedGraderEnvironment(
            process.env,
            input.workspace.registrationRoot,
          ),
          generatorSession:
            this.dependencies.generatorSession ?? runGeneratorSession,
          perspectiveSessions:
            this.dependencies.perspectiveSessions ?? runPerspectiveSessions,
          groundBuild: (options) => ({
            ...(this.dependencies.groundBuild ?? groundArtifact)(options),
            ...repositoryGraderProfileEvidence(
              options.worktree,
              options.target.graders ?? {},
            ),
          }),
        },
      },
      input.workspace.statePath,
      input.log,
    );

    const issueIntake = event.kind === 'issue'
      ? store.db.intakeRecords.find(
          (record) =>
            record.snapshot.repository === repository
            && record.snapshot.number === event.number,
        )
      : undefined;
    const matchingPr = event.kind === 'pull_request'
      ? [...store.db.prs].reverse().find(
          (pr) => pr.externalRef?.number === event.number,
        )
      : event.kind === 'issue'
        ? (() => {
          if (!issueIntake) return undefined;
          return [...store.db.prs].reverse().find((pr) =>
            issueIntake.storeIssueIds.includes(pr.issueId));
        })()
        : [...store.db.prs].reverse().find((pr) => pr.status === 'merged');
    if (input.payload.event.kind === 'repository' && !matchingPr) {
      return {
        outcome: 'completed',
        humanReview: null,
        headSha: null,
        pullRequestNumber: null,
        developmentTurn,
      };
    }
    if (
      !matchingPr
      && event.kind === 'issue'
      && issueIntake?.status === 'needs-human-review'
    ) {
      const enrichment = store.planningEnrichmentFor(issueIntake.intakeKey);
      if (
        !enrichment
        || enrichment.status !== 'needs-human-review'
        || enrichment.reasons.length === 0
        || planningHumanReviewGithub === null
      ) {
        throw new RunnerExecutionError(
          'internal_failure',
          'needs-human-review intake has no recorded planning stop reasons',
          false,
          'release',
        );
      }
      const comment = renderPlanningHumanReviewComment({
        repository,
        issueNumber: event.number,
        reasons: enrichment.reasons,
        readyLabel: input.payload.execution.readyLabel,
      });
      await input.fence.arm('release');
      const commentUrl = planningHumanReviewGithub.ensureManagedComment(
        repository,
        event.number,
        comment,
      );
      await input.fence.arm('release');
      planningHumanReviewGithub.removeClaimedLabel(
        repository,
        event.number,
        input.payload.execution.claimedLabel,
      );
      return {
        outcome: 'needs-human-review',
        humanReview: {
          issueNumber: event.number,
          reasons: [...enrichment.reasons],
          commentUrl,
        },
        headSha: null,
        pullRequestNumber: null,
        developmentTurn,
      };
    }
    if (!matchingPr) {
      throw new RunnerExecutionError(
        'provider_failure',
        'existing AgentOps turn produced no PR for the runner job',
        true,
        'provider',
      );
    }
    if (
      event.kind === 'pull_request'
      && hasDurableCurrentHeadRequestChanges(store, matchingPr)
    ) {
      return {
        outcome: 'completed',
        humanReview: null,
        headSha: matchingPr.headSha,
        pullRequestNumber: matchingPr.externalRef?.number ?? null,
        developmentTurn,
      };
    }
    if (matchingPr.status !== 'merged') {
      throw new RunnerExecutionError(
        'required_checks_failure',
        `PR #${matchingPr.externalRef?.number ?? 'unprojected'} is ${matchingPr.status}; retry reconciliation`,
        true,
        'merge',
      );
    }
    return {
      outcome: 'completed',
      humanReview: null,
      headSha: matchingPr.mergedHeadSha,
      pullRequestNumber: matchingPr.externalRef?.number ?? null,
      developmentTurn,
    };
  }
}
