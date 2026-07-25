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
  provider: 'codex' | 'claude' | 'gemini';
  log: (message: string) => void;
}

export interface AgentOpsRunnerAdapter {
  execute(input: AgentOpsAdapterInput): Promise<AgentOpsAdapterResult>;
}

function baseBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function scopedIssueRunner(
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
      fence.assertLive('push');
      return delegate.createPr(cwd, args);
    },
    viewPr: delegate.viewPr.bind(delegate),
  };
}

function guardedPrNativeRunner(
  fence: RunnerLeaseFence,
  delegate: PrNativeGithubRunner,
): PrNativeGithubRunner {
  return {
    viewRevision: delegate.viewRevision.bind(delegate),
    merge(cwd, prNumber, expectedHeadSha) {
      fence.consume('merge');
      delegate.merge(cwd, prNumber, expectedHeadSha);
    },
    closeIssue(cwd, repository, issueNumber) {
      fence.assertLive('release');
      delegate.closeIssue(cwd, repository, issueNumber);
    },
    ...(delegate.listOpenPullRequests
      ? { listOpenPullRequests: delegate.listOpenPullRequests.bind(delegate) }
      : {}),
    ...(delegate.fetchPullRequestHead
      ? { fetchPullRequestHead: delegate.fetchPullRequestHead.bind(delegate) }
      : {}),
    ...(delegate.pullRequestChangedFiles
      ? { pullRequestChangedFiles: delegate.pullRequestChangedFiles.bind(delegate) }
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
  async execute(input: AgentOpsAdapterInput): Promise<AgentOpsAdapterResult> {
    const store = new Store(input.workspace.statePath);
    if (!Store.isInitialized(input.workspace.statePath)) store.save();
    const config = runnerConfig(input);
    const realIssueRunner = realGithubIssueRunner(input.workspace.worktreePath);
    const issueRunner = input.payload.event.kind === 'issue'
      ? scopedIssueRunner(realIssueRunner, input.payload.event.number)
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
    const gateRunner = guardedGateRunner(input.fence, realGhGateRunner());
    const prNativeRunner = guardedPrNativeRunner(
      input.fence,
      realPrNativeGithubRunner(input.payload.execution.mergeMethod),
    );
    const beforeProvider = (): Promise<void> => input.fence.arm('provider');
    const beforeMergeAndRelease = async (): Promise<void> => {
      await input.fence.arm('merge');
      await input.fence.arm('release');
    };

    // Reconciliation runs before new intake. Arm both permits so restart
    // recovery can finish an already-approved exact head without bypassing.
    await beforeMergeAndRelease();
    const developmentTurn = await runGithubDevelopmentTurn(
      store,
      config,
      {
        issueRunner,
        planningRunner: async ({ intake, route }) => {
          await beforeProvider();
          return runPlanningSession(
            config,
            intake,
            route,
            input.workspace.statePath,
            input.log,
          );
        },
        uiDesignRunner: async ({ intake, candidate, route }) => {
          await beforeProvider();
          return runUiDesignSession(
            config,
            intake,
            candidate,
            route,
            input.workspace.statePath,
            input.log,
          );
        },
        prNativeRunner,
        beforeReconcile: async () => {},
        reconcileOptions: {
          beforeRelease: () => input.fence.consume('release'),
        },
        liveOptions: {
          gateRunner,
          prNativeRunner,
          beforeProviderExecution: beforeProvider,
          beforePush: () => input.fence.arm('push'),
          beforeMerge: () => input.fence.arm('merge'),
          beforeRelease: () => input.fence.arm('release'),
          assertReleasePermit: () => input.fence.consume('release'),
          generatorSession: runGeneratorSession,
          perspectiveSessions: runPerspectiveSessions,
        },
      },
      input.workspace.statePath,
      input.log,
    );

    const matchingPr = input.payload.event.kind === 'pull_request'
      ? [...store.db.prs].reverse().find(
          (pr) => pr.externalRef?.number === input.payload.event.number,
        )
      : (() => {
          const intake = store.db.intakeRecords.find(
            (record) =>
              record.snapshot.repository
                === `${input.payload.repository.owner}/${input.payload.repository.name}`
              && record.snapshot.number === input.payload.event.number,
          );
          if (!intake) return undefined;
          return [...store.db.prs].reverse().find((pr) =>
            intake.storeIssueIds.includes(pr.issueId));
        })();
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
