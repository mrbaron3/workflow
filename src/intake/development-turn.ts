/** GitHub ready Issue → planning → trace gate → existing live drive orchestration. */
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import {
  ApprovedDesignReviewProjection,
  PlanningEnrichmentOutput,
  type CapabilityReconciliationInput,
  type DesignDraftCandidate,
  type DesignRequest,
  type EnrichmentCandidate,
  type IntakeRecord,
} from '../domain/schema.js';
import { recordAgentInvocation } from '../agents/invocation.js';
import { resolveAgentRoute, type AgentRoute } from '../agents/routing.js';
import {
  createDesignflowContractConsumer,
  type DesignflowBundleInput,
  type DesignflowContractResult,
} from '../designflow/contract-consumer.js';
import {
  evaluateMaterializedDesignDecisionGate,
  type DesignDecisionGateResult,
} from '../designflow/decision-gate.js';
import {
  projectMaterializedDesignBundleReview,
} from '../designflow/review-projection.js';
import type { DriveResult } from '../pipeline/execution/loop.js';
import { runLoopLive, type LiveOptions } from '../pipeline/execution/live.js';
import type { Store } from '../store/store.js';
import {
  pollAndClaimGithubIssues,
  type GithubIssueRunner,
  type IntakePollResult,
} from './github-issues.js';
import {
  applyPlanningEnrichment,
  finalizeDesignPlanning,
  rejectDesignPlanningResolution,
  requiresUiDesign,
  uiDesignSubjectId,
  type ApprovedDesignResolution,
  type UiDesignAttempt,
} from './planning-enrichment.js';
import { runPlanningSession, type PlanningSessionResult } from './planning-session.js';
import { runUiDesignSession, type UiDesignSessionResult } from './ui-design-session.js';
import { PERSPECTIVES } from '../pipeline/panel.js';
import {
  realPrNativeGithubRunner,
  reconcilePrNativeGates,
  type AutoMergeOptions,
  type PrNativeGithubRunner,
} from '../pipeline/execution/pr-native.js';
import {
  discoverRepositoryPullRequests,
  reviewRepositoryPullRequest,
  type RepositoryPullRequestReviewer,
} from '../pipeline/execution/repository-pr.js';

export interface PlanningRunnerInput {
  intake: IntakeRecord;
  route: AgentRoute;
}

export type PlanningRunner = (input: PlanningRunnerInput) => Promise<PlanningSessionResult>;
export interface UiDesignRunnerInput {
  intake: IntakeRecord;
  candidate: EnrichmentCandidate;
  route: AgentRoute;
}
export type UiDesignRunner = (input: UiDesignRunnerInput) => Promise<UiDesignSessionResult>;
export type QueueDriver = () => Promise<DriveResult[]>;

/** Provider-facing materialization seam; it deliberately cannot return API/Issue planning. */
export interface DesignflowPlanningResolverInput {
  intake: IntakeRecord;
  draft: DesignDraftCandidate;
  designRequest: DesignRequest;
}

export interface DesignflowPlanningResolution {
  bundle: DesignflowBundleInput;
}

export type DesignflowPlanningResolver = (
  input: DesignflowPlanningResolverInput,
) => Promise<DesignflowPlanningResolution | null>;

/** Called only after WF-DF-004 approved and the consumer decoded the exact capability revision. */
export interface DesignflowCapabilityReconcilerInput
  extends DesignflowPlanningResolverInput {
  approvedContract: DesignflowContractResult;
}

export type DesignflowCapabilityReconciler = (
  input: DesignflowCapabilityReconcilerInput,
) => Promise<CapabilityReconciliationInput>;

/** Narrow consumer injection keeps orchestration independent of transport/runtime details. */
export interface DesignflowPlanningConsumer {
  validateBundle(input: DesignflowBundleInput): DesignflowContractResult;
}

export type DesignflowPlanningDecisionGate = (
  input: DesignflowBundleInput,
) => DesignDecisionGateResult;

/** Workflow-owned projection seam; production re-reads the digest-bound bundle artifacts. */
export type DesignflowReviewProjector = (
  input: DesignflowBundleInput,
) => ApprovedDesignReviewProjection;

export interface GithubDevelopmentTurnDeps {
  issueRunner: GithubIssueRunner;
  planningRunner?: PlanningRunner;
  uiDesignRunner?: UiDesignRunner;
  designflowResolver?: DesignflowPlanningResolver;
  designflowCapabilityReconciler?: DesignflowCapabilityReconciler;
  designflowConsumer?: DesignflowPlanningConsumer;
  designflowDecisionGate?: DesignflowPlanningDecisionGate;
  designflowReviewProjector?: DesignflowReviewProjector;
  driveQueue?: QueueDriver;
  prNativeRunner?: PrNativeGithubRunner;
  repositoryPullRequestReviewer?: RepositoryPullRequestReviewer;
  /** A scoped issue job must not import unrelated repository PRs. */
  discoverPullRequests?: boolean;
  /** Isolated-runner hooks; ordinary CLI callers leave these absent. */
  liveOptions?: LiveOptions;
  beforeIssueClaim?: () => Promise<void>;
  beforeReconcile?: () => Promise<void>;
  reconcileOptions?: AutoMergeOptions;
}

export interface GithubDevelopmentTurnResult {
  intake: IntakePollResult[];
  enrichmentIds: string[];
  driveResults: DriveResult[];
}

export interface GithubTurnRegistrationOverrides {
  readyLabel?: string;
  baseBranch?: string;
}

/**
 * Repository registration values are invocation-scoped and take precedence over
 * the workspace defaults. The workspace file is never rewritten by the daemon.
 */
export function applyGithubTurnRegistrationOverrides(
  config: HarnessConfig,
  overrides: GithubTurnRegistrationOverrides,
): HarnessConfig {
  const readyLabel = overrides.readyLabel?.trim();
  const baseBranch = overrides.baseBranch?.trim();
  if (overrides.readyLabel !== undefined && !readyLabel) {
    throw new Error('github-turn ready label override must be non-empty');
  }
  if (overrides.baseBranch !== undefined && !baseBranch) {
    throw new Error('github-turn base branch override must be non-empty');
  }
  return {
    ...config,
    ...(baseBranch ? { baseBranch } : {}),
    ...(config.intake
      ? {
          intake: {
            ...config.intake,
            ...(readyLabel ? { readyLabel } : {}),
          },
        }
      : {}),
    ...(baseBranch
      ? {
          gate: {
            ...(config.gate ?? { backend: 'store' as const }),
            baseBranch,
          },
        }
      : {}),
  };
}

export async function runGithubDevelopmentTurn(
  store: Store,
  config: HarnessConfig,
  deps: GithubDevelopmentTurnDeps,
  harnessRoot: string = process.cwd(),
  log: (message: string) => void = () => {},
): Promise<GithubDevelopmentTurnResult> {
  const prNativeRunner = deps.prNativeRunner
    ?? realPrNativeGithubRunner(config.gate?.mergeMethod);
  if ((config.gate?.backend ?? 'store') === 'github' && config.target) {
    const targetRoot = path.resolve(harnessRoot, config.target.repo);
    const discoveries = deps.discoverPullRequests === false
      ? []
      : discoverRepositoryPullRequests(
          store,
          config,
          prNativeRunner,
          targetRoot,
        );
    const review = deps.repositoryPullRequestReviewer
      ?? ((discovery) => reviewRepositoryPullRequest(
        store,
        config,
        discovery,
        prNativeRunner,
        harnessRoot,
        log,
        PERSPECTIVES,
        {
          ...(deps.liveOptions?.graderEnvironment
            ? {
                graderEnvironment: deps.liveOptions.graderEnvironment,
                graderIsolation: 'runner-container' as const,
              }
            : {}),
          ...(deps.liveOptions?.beforeProviderExecution
            ? { beforeProviderExecution: deps.liveOptions.beforeProviderExecution }
            : {}),
        },
      ));
    for (const discovery of discoveries) {
      if (discovery.imported) {
        log(
          `⇩ discovered ${discovery.pr.id} from repository PR `
          + `#${discovery.pullRequest.number}@${discovery.revision.headSha.slice(0, 12)}`,
        );
      }
      if (discovery.reviewRequired) await review(discovery);
    }
    await deps.beforeReconcile?.();
    const results = reconcilePrNativeGates(
      store,
      config,
      prNativeRunner,
      targetRoot,
      PERSPECTIVES.map((perspective) => perspective.key),
      deps.reconcileOptions,
    );
    for (const result of results) {
      log(
        `⇩ reconciled ${result.prId}@${result.headSha?.slice(0, 12) ?? 'unobserved'} → ${result.decision}`
        + (result.reasons.length ? ` (${result.reasons.join('; ')})` : ''),
      );
    }
  }
  const intakeResults = await pollAndClaimGithubIssues(
    store,
    config,
    deps.issueRunner,
    deps.beforeIssueClaim,
  );
  const systemDir = config.target?.systemDir
    ? path.resolve(harnessRoot, config.target.systemDir)
    : path.join(config.target ? path.resolve(harnessRoot, config.target.repo) : harnessRoot, 'docs', '_system');
  const route = resolveAgentRoute(config, 'planning');
  const planningRunner = deps.planningRunner ?? ((input) => runPlanningSession(config, input.intake, input.route, harnessRoot, log));
  const uiDesignRunner = deps.uiDesignRunner
    ?? ((input) => runUiDesignSession(config, input.intake, input.candidate, input.route, harnessRoot, log));
  const enrichmentIds: string[] = [];

  // Store inventory, not just this poll's return, is the resume source of truth.
  const pending = store.db.intakeRecords
    .filter((record) => (record.status === 'claimed' || record.status === 'planning') && !store.planningEnrichmentFor(record.intakeKey))
    .sort((a, b) => a.snapshot.number - b.snapshot.number);
  for (const intake of pending) {
    intake.status = 'planning';
    store.save();
    const result = await planningRunner({ intake, route });
    const routeMismatch = result.provider !== route.provider
      || (route.model !== null && result.model !== route.model);
    if (routeMismatch) {
      log(
        `\u26a0 planning route mismatch for ${intake.intakeKey}: expected ${route.provider}/${route.model ?? 'default'}, `
        + `got ${result.provider}/${result.model ?? 'default'}`,
      );
    }
    const invocation = recordAgentInvocation(store, {
      subjectId: intake.intakeKey,
      attempt: 1,
      role: 'issue-planner',
      perspective: null,
      provider: result.provider,
      model: result.model,
      prompt: result.prompt,
      // Record what actually ran, but make a route mismatch fail closed at the provenance gate.
      outcome: routeMismatch ? 'failed' : result.outcome,
    });
    const uiDesigns: Record<string, UiDesignAttempt> = {};
    const planningOutput = PlanningEnrichmentOutput.safeParse(result.output);
    const configuredDesignProviders = config.intake?.designProviders ?? {};
    if (invocation.outcome === 'completed' && planningOutput.success) {
      let selectedUiDesignRoute: AgentRoute | null = null;
      for (const candidate of planningOutput.data.candidates.filter(requiresUiDesign)) {
        // The retained session is an adapter, not an implicit fallback. A malformed, missing,
        // or Designflow selection is rejected by the deterministic enrichment gate below.
        if (configuredDesignProviders[candidate.candidateKey] !== 'legacy-ui-design') {
          continue;
        }
        selectedUiDesignRoute ??= resolveAgentRoute(config, 'ui-design');
        const uiDesignRoute = selectedUiDesignRoute;
        const uiResult = await uiDesignRunner({ intake, candidate, route: uiDesignRoute });
        const uiRouteMismatch = uiResult.provider !== uiDesignRoute.provider
          || (uiDesignRoute.model !== null && uiResult.model !== uiDesignRoute.model);
        if (uiRouteMismatch) {
          log(
            `⚠ UI design route mismatch for ${intake.intakeKey}/${candidate.candidateKey}: `
            + `expected ${uiDesignRoute.provider}/${uiDesignRoute.model ?? 'default'}, `
            + `got ${uiResult.provider}/${uiResult.model ?? 'default'}`,
          );
        }
        const uiInvocation = recordAgentInvocation(store, {
          subjectId: uiDesignSubjectId(intake.intakeKey, candidate.candidateKey),
          attempt: 1,
          role: 'ui-designer',
          perspective: null,
          provider: uiResult.provider,
          model: uiResult.model,
          prompt: uiResult.prompt,
          outcome: uiRouteMismatch ? 'failed' : uiResult.outcome,
        });
        uiDesigns[candidate.candidateKey] = {
          output: uiResult.output,
          invocationKey: uiInvocation.invocationKey,
        };
      }
    }
    const enrichment = applyPlanningEnrichment(store, config, intake.intakeKey, result.output, {
      systemDir,
      invocationKey: invocation.invocationKey,
      uiDesigns,
    });
    enrichmentIds.push(enrichment.id);
  }

  // Design-pending records are durable resume state. Never rerun planning and never allocate
  // an Issue until every draft resolves to a consumer-validated, human-approved bundle.
  const awaitingDesign = store.db.planningEnrichments
    .filter((enrichment) => enrichment.status === 'awaiting-design')
    .sort((left, right) => {
      const leftNumber = store.intakeByKey(left.intakeKey)?.snapshot.number ?? Number.MAX_SAFE_INTEGER;
      const rightNumber = store.intakeByKey(right.intakeKey)?.snapshot.number ?? Number.MAX_SAFE_INTEGER;
      return leftNumber - rightNumber || left.intakeKey.localeCompare(right.intakeKey);
    });
  if (awaitingDesign.length > 0) {
    const consumer = deps.designflowConsumer
      ?? (deps.designflowResolver
        ? createDesignflowContractConsumer({ repositoryRoot: harnessRoot })
        : null);
    const decisionGate = deps.designflowDecisionGate
      ?? evaluateMaterializedDesignDecisionGate;
    const reviewProjector = deps.designflowReviewProjector
      ?? projectMaterializedDesignBundleReview;
    for (const enrichment of awaitingDesign) {
      const intake = store.intakeByKey(enrichment.intakeKey);
      if (!intake) throw new Error(`No intake record: ${enrichment.intakeKey}`);
      if (!deps.designflowResolver || consumer === null) {
        const rejected = rejectDesignPlanningResolution(
          store,
          enrichment.intakeKey,
          ['selected Designflow provider is unavailable'],
        );
        if (!enrichmentIds.includes(rejected.id)) enrichmentIds.push(rejected.id);
        log(`⚠ Designflow provider unavailable for ${enrichment.intakeKey}`);
        continue;
      }
      const resolutions: ApprovedDesignResolution[] = [];
      let complete = true;
      for (const designDraft of enrichment.designDrafts) {
        try {
          const resolution = await deps.designflowResolver({
            intake,
            draft: designDraft.candidate,
            designRequest: designDraft.designRequest,
          });
          if (!resolution) {
            throw new Error('selected Designflow provider returned no resolution');
          }
          const gate = decisionGate(resolution.bundle);
          let contract: DesignflowContractResult | null = null;
          let reconciliation: CapabilityReconciliationInput | null = null;
          let reviewProjection: ApprovedDesignResolution['reviewProjection'] = null;
          if (gate.status === 'approved') {
            contract = consumer.validateBundle(resolution.bundle);
            reviewProjection = ApprovedDesignReviewProjection.parse(
              reviewProjector(resolution.bundle),
            );
            const capabilityReconciler = deps.designflowCapabilityReconciler;
            if (!capabilityReconciler) {
              throw new Error(
                'workflow capability reconciler is not configured for an approved bundle',
              );
            }
            reconciliation = await capabilityReconciler({
              intake,
              draft: designDraft.candidate,
              designRequest: designDraft.designRequest,
              approvedContract: contract,
            });
          }
          resolutions.push({
            candidateKey: designDraft.candidate.candidateKey,
            contract,
            decisionGate: gate,
            reviewProjection,
            reconciliation,
          });
        } catch (error) {
          complete = false;
          const detail = error instanceof Error ? error.message : String(error);
          const rejected = rejectDesignPlanningResolution(
            store,
            enrichment.intakeKey,
            [
              `${designDraft.candidate.candidateKey}: invalid Designflow resolution: ${detail}`,
            ],
          );
          if (!enrichmentIds.includes(rejected.id)) enrichmentIds.push(rejected.id);
          log(
            `⚠ Designflow bundle rejected for ${enrichment.intakeKey}/`
            + `${designDraft.candidate.candidateKey}: `
            + detail,
          );
          break;
        }
      }
      if (!complete) continue;
      const finalized = finalizeDesignPlanning(
        store,
        config,
        enrichment.intakeKey,
        resolutions,
        { systemDir },
      );
      if (!enrichmentIds.includes(finalized.id)) enrichmentIds.push(finalized.id);
    }
  }

  // The downstream is the existing queue driver — no intake-specific implementation pipeline.
  const driveQueue = deps.driveQueue
    ?? (() => runLoopLive(
      store,
      config,
      harnessRoot,
      { ...deps.liveOptions, prNativeRunner },
      log,
    ));
  const driveResults = await driveQueue();
  return { intake: intakeResults, enrichmentIds, driveResults };
}

export interface WatchGithubDevelopmentOptions {
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Safe deterministic pacing when the recurring watcher has no valid configured interval. */
export const DEFAULT_GITHUB_WATCH_INTERVAL_MS = 30_000;

/** Node clamps setTimeout delays above 2^31−1 ms to 1 ms, so larger configured values are invalid. */
export const MAX_GITHUB_WATCH_INTERVAL_MS = 2_147_483_647;

function configuredGithubWatchInterval(config: HarnessConfig): number {
  const configured = config.intake?.pollIntervalMs;
  return typeof configured === 'number'
    && Number.isFinite(configured)
    && Number.isInteger(configured)
    && configured > 0
    && configured <= MAX_GITHUB_WATCH_INTERVAL_MS
    ? configured
    : DEFAULT_GITHUB_WATCH_INTERVAL_MS;
}

/** Recurring monitor; failures are surfaced and retried from durable store inventory next turn. */
export async function watchGithubDevelopment(
  store: Store,
  config: HarnessConfig,
  deps: GithubDevelopmentTurnDeps,
  harnessRoot: string = process.cwd(),
  log: (message: string) => void = () => {},
  opts: WatchGithubDevelopmentOptions = {},
): Promise<never> {
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = opts.intervalMs ?? configuredGithubWatchInterval(config);
  for (;;) {
    try {
      await runGithubDevelopmentTurn(store, config, deps, harnessRoot, log);
    } catch (error) {
      log(`⚠ GitHub development turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await wait(intervalMs);
  }
}
