/**
 * AgentRunner: the pluggable generation backend for the DETERMINISTIC loop (coordinator demo /
 * driveOnce). `mock` is the only backend here — offline, deterministic, runnable today.
 *
 * Real agents (claude/…) are NOT driven through this seam: they run as interactive tmux sessions
 * on a real worktree (ARCH-execution-003, src/pipeline/execution/*), grounded by real tsc/vitest.
 * The old headless `claude -p` CliAgentRunner was deprecated with the tmux orchestration
 * (ADR-0005 Q2 — headless is a North-Star non-goal); the AgentRunner interface itself stays.
 */

import type { HarnessConfig } from '../config.js';
import type { AgentProvider } from '../domain/schema.js';
import type { BuildArtifact, GenerateInput } from '../domain/artifact.js';
import { MockAgentRunner } from './mock.js';

export interface AgentRunner {
  readonly agent: AgentProvider;
  /** Produce a build artifact for the given issue contract (and optional repair brief). */
  generate(input: GenerateInput): Promise<BuildArtifact>;
}

export function makeRunner(config: HarnessConfig): AgentRunner {
  if (config.generator === 'mock') return new MockAgentRunner();
  throw new Error(
    `generator "${config.generator}" has no in-process runner: real agents run as live tmux ` +
      `sessions (npx tsx apps/agentops/scripts/real-panel-run.ts / runLoopLive), not the deprecated headless ` +
      `CLI (ADR-0005 Q2). Set generator to "mock" for the offline deterministic loop.`,
  );
}

export type { BuildArtifact, GenerateInput };
