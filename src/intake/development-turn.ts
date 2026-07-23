/** GitHub ready Issue → planning → trace gate → existing live drive orchestration. */
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { PlanningEnrichmentOutput, type EnrichmentCandidate, type IntakeRecord } from '../domain/schema.js';
import { recordAgentInvocation } from '../agents/invocation.js';
import { resolveAgentRoute, type AgentRoute } from '../agents/routing.js';
import type { DriveResult } from '../pipeline/execution/loop.js';
import { runLoopLive } from '../pipeline/execution/live.js';
import type { Store } from '../store/store.js';
import {
  pollAndClaimGithubIssues,
  type GithubIssueRunner,
  type IntakePollResult,
} from './github-issues.js';
import {
  applyPlanningEnrichment,
  requiresUiDesign,
  uiDesignSubjectId,
  type UiDesignAttempt,
} from './planning-enrichment.js';
import { runPlanningSession, type PlanningSessionResult } from './planning-session.js';
import { runUiDesignSession, type UiDesignSessionResult } from './ui-design-session.js';

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

export interface GithubDevelopmentTurnDeps {
  issueRunner: GithubIssueRunner;
  planningRunner?: PlanningRunner;
  uiDesignRunner?: UiDesignRunner;
  driveQueue?: QueueDriver;
}

export interface GithubDevelopmentTurnResult {
  intake: IntakePollResult[];
  enrichmentIds: string[];
  driveResults: DriveResult[];
}

export async function runGithubDevelopmentTurn(
  store: Store,
  config: HarnessConfig,
  deps: GithubDevelopmentTurnDeps,
  harnessRoot: string = process.cwd(),
  log: (message: string) => void = () => {},
): Promise<GithubDevelopmentTurnResult> {
  const intakeResults = pollAndClaimGithubIssues(store, config, deps.issueRunner);
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
    if (invocation.outcome === 'completed' && planningOutput.success) {
      let selectedUiDesignRoute: AgentRoute | null = null;
      for (const candidate of planningOutput.data.candidates.filter(requiresUiDesign)) {
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

  // The downstream is the existing queue driver — no intake-specific implementation pipeline.
  const driveQueue = deps.driveQueue ?? (() => runLoopLive(store, config, harnessRoot, {}, log));
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
