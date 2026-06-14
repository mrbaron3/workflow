/**
 * AgentRunner: the pluggable generation backend.
 *
 * The pipeline only knows this interface. `mock` is the default (offline,
 * deterministic, runnable today). Switching config.generator to claude/codex/gemini
 * selects the CLI runner, which shells out to that tool.
 */

import type { HarnessConfig } from '../config.js';
import type { GeneratorAgent } from '../domain/schema.js';
import type { BuildArtifact, GenerateInput } from '../domain/artifact.js';
import { MockAgentRunner } from './mock.js';
import { CliAgentRunner } from './cli.js';

export interface AgentRunner {
  readonly agent: GeneratorAgent;
  /** Produce a build artifact for the given issue contract (and optional repair brief). */
  generate(input: GenerateInput): Promise<BuildArtifact>;
}

export function makeRunner(config: HarnessConfig): AgentRunner {
  switch (config.generator) {
    case 'mock':
      return new MockAgentRunner();
    case 'claude':
    case 'codex':
    case 'gemini':
      return new CliAgentRunner(config.generator, config.cli[config.generator]);
    default:
      return new MockAgentRunner();
  }
}

export type { BuildArtifact, GenerateInput };
