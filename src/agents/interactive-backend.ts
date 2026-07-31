/**
 * Provider-neutral interactive session command adapters (FEAT-014).
 * Execution supplies intent; every CLI flag and readiness marker lives here.
 */
import path from 'node:path';
import type { AgentProvider } from '../domain/schema.js';

export type InteractivePurpose = 'generator' | 'reviewer' | 'planner' | 'ui-designer';

export interface InteractiveLaunchRequest {
  provider: AgentProvider;
  session: string;
  cwd: string;
  purpose: InteractivePurpose;
  model?: string;
  additionalDirs?: string[];
  /** Extra roots a provider must treat as trusted (codex keys trust by git repository root). */
  trustRoots?: readonly string[];
  /**
   * A disposable per-session provider config home the launch may write to. Absent for an
   * operator's own config home, which a launch must never rewrite.
   */
  disposableConfigHome?: string;
}

export interface InteractiveAgentBackend {
  readonly provider: AgentProvider;
  readonly readyPattern: RegExp;
  buildCommand(request: InteractiveLaunchRequest): string;
}

/** POSIX-shell single argument quoting for the command string tmux starts. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const claudeBackend: InteractiveAgentBackend = {
  provider: 'claude',
  readyPattern: /accept edits on|❯/,
  buildCommand(request) {
    const tools = request.purpose === 'generator' ? 'Read Edit Write Bash' : 'Read Write Bash';
    const model = request.model ? ` --model ${shellQuote(request.model)}` : '';
    const addDirs = (request.additionalDirs ?? []).map((dir) => ` --add-dir ${shellQuote(dir)}`).join('');
    return (
      `claude -n ${shellQuote(request.session)} ` +
      `--permission-mode acceptEdits --allowedTools ${shellQuote(tools)}${model}${addDirs}`
    );
  },
};

const codexBackend: InteractiveAgentBackend = {
  provider: 'codex',
  readyPattern: /›|codex>/i,
  buildCommand(request) {
    const model = request.model ? ` --model ${shellQuote(request.model)}` : '';
    const addDirs = (request.additionalDirs ?? []).map((dir) => ` --add-dir ${shellQuote(dir)}`).join('');
    // Codex asks whether the working directory is trusted before it accepts any input. Left
    // unanswered the readiness marker still matches (the menu draws `›`), the driver types the
    // prompt into the menu, and codex quits — the session dies before it starts. Measured against
    // codex 0.145: `-c projects.<path>.trust_level=…` never applies, in any quoting; only a config
    // file does. TOML quotes the path key, so roots containing dots survive. Codex keys trust by
    // git repository root as well as cwd, so both are written. This runs ONLY against a disposable
    // per-session config home — an operator's own config is never rewritten — and hook trust is
    // deliberately not bypassed, so repository-supplied hooks stay gated.
    const prelude = request.disposableConfigHome
      ? `${[...new Set([request.cwd, ...(request.trustRoots ?? [])])]
          .map((root, index) =>
            `printf '[projects."%s"]\\ntrust_level = "trusted"\\n' ${shellQuote(root)} `
            + `${index === 0 ? '>' : '>>'} `
            + `${shellQuote(path.join(request.disposableConfigHome!, 'config.toml'))}`)
          .join(' && ')} && `
      : '';
    return (
      `${prelude}codex --no-alt-screen --ask-for-approval never `
      + `--sandbox workspace-write${model}${addDirs}`
    );
  },
};

export class UnsupportedInteractiveProviderError extends Error {
  constructor(readonly provider: AgentProvider) {
    super(`Unsupported interactive agent provider: ${provider}`);
    this.name = 'UnsupportedInteractiveProviderError';
  }
}

export function backendFor(provider: AgentProvider): InteractiveAgentBackend {
  if (provider === 'claude') return claudeBackend;
  if (provider === 'codex') return codexBackend;
  throw new UnsupportedInteractiveProviderError(provider);
}

export function buildInteractiveLaunchCommand(request: InteractiveLaunchRequest): string {
  return backendFor(request.provider).buildCommand(request);
}

export function providerReadyPattern(provider: AgentProvider): RegExp {
  return backendFor(provider).readyPattern;
}
