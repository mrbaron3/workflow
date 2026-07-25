import type { HarnessConfig } from '../config.js';
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
import { RunnerExecutionError } from './errors.js';
import type { RunnerLeaseFence } from './guard.js';
import { isolatedGraderEnvironment } from './security.js';
import type { PreparedRunnerWorkspace } from './workspace.js';

export interface AgentOpsAdapterResult {
  headSha: string | null;
  pullRequestNumber: number | null;
  developmentTurn: GithubDevelopmentTurnResult;
}

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
}

function baseBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
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

function runnerConfig(input: AgentOpsAdapterInput): HarnessConfig {
  const repository = `${input.payload.repository.owner}/${input.payload.repository.name}`;
  const branch = baseBranch(input.payload.target.baseRef);
  const route = { provider: input.provider };
  return {
    ...DEFAULT_CONFIG,
    generator: input.provider,
    samples: 1,
    maxConcurrentIssues: 1,
    baseBranch: branch,
    target: {
      repo: input.workspace.worktreePath,
      baseRef: input.payload.target.baseRef,
      systemDir: `${input.workspace.worktreePath}/docs/_system`,
      protectedPaths: ['.git', '.github/workflows'],
      graders: {
        typecheck: 'npm run typecheck',
        unit_tests: 'npm test',
        commands: {
          build: 'npm run build',
          typecheck: 'npm run typecheck',
          unit_test: 'npm test',
        },
      },
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
      readyLabel: 'ready',
      claimedLabel: 'agent-claimed',
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
          ...(this.dependencies.groundBuild
            ? { groundBuild: this.dependencies.groundBuild }
            : {}),
        },
      },
      input.workspace.statePath,
      input.log,
    );

    const matchingPr = event.kind === 'pull_request'
      ? [...store.db.prs].reverse().find(
          (pr) => pr.externalRef?.number === event.number,
        )
      : event.kind === 'issue'
        ? (() => {
          const intake = store.db.intakeRecords.find(
            (record) =>
              record.snapshot.repository
                === `${input.payload.repository.owner}/${input.payload.repository.name}`
              && record.snapshot.number === event.number,
          );
          if (!intake) return undefined;
          return [...store.db.prs].reverse().find((pr) =>
            intake.storeIssueIds.includes(pr.issueId));
        })()
        : [...store.db.prs].reverse().find((pr) => pr.status === 'merged');
    if (input.payload.event.kind === 'repository' && !matchingPr) {
      return {
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
    if (matchingPr.status !== 'merged') {
      throw new RunnerExecutionError(
        'required_checks_failure',
        `PR #${matchingPr.externalRef?.number ?? 'unprojected'} is ${matchingPr.status}; retry reconciliation`,
        true,
        'merge',
      );
    }
    return {
      headSha: matchingPr.mergedHeadSha,
      pullRequestNumber: matchingPr.externalRef?.number ?? null,
      developmentTurn,
    };
  }
}
