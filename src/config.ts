/**
 * Harness configuration. Written to .harness/config.json by `init` and read by
 * every command. Defaults make the harness runnable today with the mock backend;
 * switching `generator` to claude/codex/gemini wires in a real CLI (see agents/cli.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GeneratorAgent } from './domain/schema.js';

export interface AgentCliConfig {
  /** Executable to run, e.g. "claude". */
  command: string;
  /**
   * Argument template. The token "{promptFile}" is replaced with a path to a temp
   * file containing the rendered prompt; "{prompt}" with the prompt text inline.
   */
  args: string[];
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
  graders?: { typecheck?: string; unit_tests?: string };
  protectedPaths?: string[];
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

export interface HarnessConfig {
  /** Active generator backend. "mock" runs fully offline; others shell out. */
  generator: GeneratorAgent;
  baseBranch: string;
  /** Independent best-of-N samples per issue. Drives pass@k / pass^k. */
  samples: number;
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
  /** CLI templates for real agent backends (used when generator != "mock"). */
  cli: Record<'claude' | 'codex' | 'gemini', AgentCliConfig>;
  /** Target repo for grounded runs (execution layer edits worktrees of it). */
  target?: TargetRepoConfig;
  /** Human review gate backend (ADR-0006 G1). Absent = store-direct gate (current behavior). */
  gate?: GateConfig;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  generator: 'mock',
  baseBranch: 'main',
  samples: 3,
  maxRepairs: 2,
  passThreshold: 0.7,
  scoreWeights: {
    functionality: 0.4,
    codeQuality: 0.2,
    testQuality: 0.15,
    ux: 0.15,
    accessibility: 0.1,
  },
  cli: {
    // Claude Code, headless print mode.
    claude: { command: 'claude', args: ['-p', '{prompt}'] },
    // OpenAI Codex CLI, non-interactive exec.
    codex: { command: 'codex', args: ['exec', '{prompt}'] },
    // Gemini CLI.
    gemini: { command: 'gemini', args: ['-p', '{prompt}'] },
  },
};

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
    cli: { ...DEFAULT_CONFIG.cli, ...(raw.cli ?? {}) },
  };
}

export function saveConfig(root: string, cfg: HarnessConfig): void {
  const p = configPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
