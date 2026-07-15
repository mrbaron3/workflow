/**
 * Harness configuration. Written to .harness/config.json by `init` and read by
 * every command. Defaults make the harness runnable today with the mock backend;
 * switching `generator` to claude/codex/gemini wires in a real CLI (see agents/cli.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentProvider, GeneratorAgent, VerificationMethod } from './domain/schema.js';

export interface TargetGraderConfig {
  /** Legacy aliases retained for existing configs. */
  typecheck?: string;
  unit_tests?: string;
  /** Canonical verification-method → grounded command registry (FEAT-019). */
  commands?: Partial<Record<VerificationMethod, string>>;
}

/**
 * A real target repository the execution layer edits in isolated git worktrees
 * (ADR-0005 / _system/execution). Present only for grounded real-agent runs; absent for
 * the mock backend. `graders` are real commands run against the checkout (evidence, not
 * self-report); `protectedPaths` are harness-owned files the agent must not edit.
 */
export interface TargetRepoConfig {
  repo: string;
  baseRef?: string;
  graders?: TargetGraderConfig;
  protectedPaths?: string[];
  /**
   * Where the target's `_system` design views live (for scoped-context resolution of an issue's
   * dependsOnSystem, ARCH-execution-007). Relative to harnessRoot or absolute. Absent = scoped
   * design context disabled (the generator gets the contract only).
   */
  systemDir?: string;
}

/** Resolve one configured grader without inventing a fallback for another verification method. */
export function configuredGraderCommand(
  target: TargetRepoConfig | undefined,
  method: VerificationMethod,
): string | undefined {
  if (method === 'manual') return undefined;
  const direct = target?.graders?.commands?.[method];
  if (typeof direct === 'string' && direct.trim() !== '') return direct;
  if (method === 'typecheck') return target?.graders?.typecheck;
  if (method === 'unit_test') return target?.graders?.unit_tests;
  return undefined;
}

/**
 * The human review gate's backend (ADR-0006 G1-G2). `store` (default) keeps the gate
 * direct — an approved build stops at needs-human-review and a human calls recordHumanDecision
 * (CLI / dashboard); nothing leaves the machine. `github` projects the approved build to a real
 * PR (push + `gh pr create`) and polls that PR's merge/close as the human decision. The store
 * stays SoT either way; github is opt-in and requires a pushable remote + `gh` auth.
 */
export interface GateConfig {
  backend: 'store' | 'github';
  /** github only: base branch for the PR (defaults to config.baseBranch). */
  baseBranch?: string;
}

/**
 * Legacy per-role model fallbacks. `routes` is the provider-neutral configuration; these fields
 * remain for existing configs and are interpreted by the selected provider adapter. Absent means
 * inherit that provider CLI's default model.
 */
export interface ModelConfig {
  generator?: string;
  reviewer?: string;
}

/** Provider and optional provider-specific model selected for one role/perspective. */
export interface AgentRouteConfig {
  provider: AgentProvider;
  model?: string;
}

/** Additive deterministic routing table (FEAT-015). */
export interface AgentRoutingConfig {
  generator?: AgentRouteConfig;
  planning?: AgentRouteConfig;
  /** Dedicated UI/UX authoring session; falls back to planning when absent. */
  uiDesign?: AgentRouteConfig;
  reviewer?: AgentRouteConfig;
  perspectives?: Record<string, AgentRouteConfig>;
}

/** Optional external WHAT intake. Absent means no GitHub Issue polling. */
export interface IntakeConfig {
  backend: 'github';
  repository: string; // owner/name
  readyLabel?: string;
  claimedLabel?: string;
}

export interface HarnessConfig {
  /** Active generator backend. "mock" runs fully offline; others shell out. */
  generator: GeneratorAgent;
  baseBranch: string;
  /** Independent best-of-N samples per issue. Drives pass@k / pass^k. */
  samples: number;
  /**
   * Max ai-managed issues driven concurrently in one live turn (FEAT-008). Finite by
   * contract — unbounded parallelism is a red line, so use `resolveConcurrentIssueCap`
   * to read it (non-finite values fall back to the finite default). 1 = today's
   * sequential drive, exactly.
   */
  maxConcurrentIssues: number;
  /** Max repair iterations per sample before giving up / escalating. */
  maxRepairs: number;
  /** When no blocker fails, an EvalRun passes if overall >= this. */
  passThreshold: number;
  /** Weights for the composite `overall` score (need not sum to 1; normalised). */
  scoreWeights: {
    functionality: number;
    codeQuality: number;
    testQuality: number;
    ux: number;
    accessibility: number;
  };
  /** Target repo for grounded runs (execution layer edits worktrees of it). */
  target?: TargetRepoConfig;
  /** Human review gate backend (ADR-0006 G1). Absent = store-direct gate (current behavior). */
  gate?: GateConfig;
  /** Per-role session model overrides. Absent = every role inherits the user's default model. */
  models?: ModelConfig;
  /** Role/perspective provider routes. Absent preserves the legacy generator/models behavior. */
  routes?: AgentRoutingConfig;
  /** GitHub Issue intake projection (ADR-0008). */
  intake?: IntakeConfig;
  /** Evaluator panel tuning (ADR-0006 E4). */
  panel?: {
    /** Max review sessions to fan out concurrently (saturation guard: machine / rate limits). */
    maxConcurrent?: number;
  };
}

/**
 * Panel review-session fan-out default (ADR-0006 E4) — the single source (AC-PIN-003).
 * Callsites must wire to this export, never re-encode the value as an inline literal:
 * the double encoding let a value-breaking mutation of one copy survive the suite.
 */
export const DEFAULT_PANEL_MAX_CONCURRENT = 4;

export const DEFAULT_CONFIG: HarnessConfig = {
  generator: 'mock',
  baseBranch: 'main',
  samples: 3,
  maxConcurrentIssues: 2,
  maxRepairs: 2,
  passThreshold: 0.7,
  scoreWeights: {
    functionality: 0.4,
    codeQuality: 0.2,
    testQuality: 0.15,
    ux: 0.15,
    accessibility: 0.1,
  },
  panel: { maxConcurrent: DEFAULT_PANEL_MAX_CONCURRENT },
};

/**
 * The effective concurrent-issue cap for a live turn (ISSUE-0019). Finite BY CONTRACT
 * (red line: no config may introduce unbounded concurrency): a non-numeric or non-finite
 * configured value falls back to the finite default; fractions floor; anything below 1
 * clamps to 1 — a cap can slow the queue to sequential, never silently starve it.
 */
export function resolveConcurrentIssueCap(config: HarnessConfig): number {
  const raw = config.maxConcurrentIssues;
  const finite = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CONFIG.maxConcurrentIssues;
  return Math.max(1, finite);
}

/**
 * The panel's effective review-session fan-out cap (AC-PIN-003). The `??` fallback used to
 * sit inline in runPerspectiveSessions — deliberately not unit-tested (live tmux) — so a
 * re-inlined literal there survived the suite. Extracted as a pure resolver, mirroring
 * resolveConcurrentIssueCap's seam shape, so the fallback wiring itself is pin-testable.
 * Semantics are exactly the old callsite fallback (behavior-preserving REFACTOR): a
 * configured value passes through untouched; only an absent one falls back to the default.
 */
export function resolvePanelMaxConcurrent(config: HarnessConfig): number {
  return config.panel?.maxConcurrent ?? DEFAULT_PANEL_MAX_CONCURRENT;
}

/**
 * The absolute root of whichever repo the authoring chain is currently rooted in (D4 /
 * AC-TROOT-001,005): `config.target.repo` resolved against `harnessRoot` when configured, else
 * `harnessRoot` itself — today's self-authoring behavior (also reached when `target.repo` is the
 * explicit self-hosting spelling `'.'`, since resolving `.` against harnessRoot yields harnessRoot
 * unchanged). spawnSpecs / sign both resolve "which repo is WHAT rooted in" through this single
 * seam so they can never disagree about it.
 */
export function resolveTargetRoot(config: HarnessConfig, harnessRoot: string): string {
  if (!config.target?.repo) return harnessRoot;
  return path.resolve(harnessRoot, config.target.repo);
}

export function configPath(root: string): string {
  return path.join(root, '.harness', 'config.json');
}

export function loadConfig(root: string): HarnessConfig {
  const p = configPath(root);
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<HarnessConfig>;
  // Shallow merge over defaults so partial configs stay valid as the schema grows.
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    scoreWeights: { ...DEFAULT_CONFIG.scoreWeights, ...(raw.scoreWeights ?? {}) },
    panel: { ...DEFAULT_CONFIG.panel, ...(raw.panel ?? {}) },
  };
}

export function saveConfig(root: string, cfg: HarnessConfig): void {
  const p = configPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
