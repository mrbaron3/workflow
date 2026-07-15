/** FEAT-014 — provider-neutral interactive request mapped by CLI-specific adapters. */
import { describe, expect, it } from 'vitest';
import { buildLaunchCommand } from '../src/pipeline/execution/tmux.js';
import {
  UnsupportedInteractiveProviderError,
  backendFor,
  providerReadyPattern,
} from '../src/agents/interactive-backend.js';

describe('interactive provider adapters', () => {
  it('AC-AGBACK-001 builds a Claude generator command from the common request', () => {
    const cmd = buildLaunchCommand({
      provider: 'claude', session: 'ao-x', cwd: '/wt', purpose: 'generator', model: 'sonnet',
      additionalDirs: ['/harness/evidence'],
    });
    expect(cmd).toContain("claude -n 'ao-x'");
    expect(cmd).toContain('--permission-mode acceptEdits');
    expect(cmd).toContain("--allowedTools 'Read Edit Write Bash'");
    expect(cmd).toContain("--model 'sonnet'");
    expect(cmd).toContain("--add-dir '/harness/evidence'");
  });

  it('AC-AGBACK-001 narrows Claude reviewer tools without changing the request vocabulary', () => {
    const cmd = buildLaunchCommand({ provider: 'claude', session: 'ao-review', cwd: '/rv', purpose: 'reviewer' });
    expect(cmd).toContain("--allowedTools 'Read Write Bash'");
    expect(cmd).not.toContain('--model');
  });

  it('uses the same read/write-evidence capability shape for a planning session', () => {
    const cmd = buildLaunchCommand({ provider: 'codex', session: 'ao-plan', cwd: '/plan', purpose: 'planner' });
    expect(cmd).toContain('codex --no-alt-screen');
    expect(cmd).toContain('--ask-for-approval never');
  });

  it('AC-AGBACK-002/003 builds an interactive Codex command from the same request', () => {
    const cmd = buildLaunchCommand({
      provider: 'codex', session: 'ao-x', cwd: '/wt', purpose: 'generator', model: 'gpt-5.1-codex',
      additionalDirs: ['/harness/evidence'],
    });
    expect(cmd.startsWith('codex ')).toBe(true);
    expect(cmd).toContain('--no-alt-screen');
    expect(cmd).toContain('--ask-for-approval never');
    expect(cmd).toContain('--sandbox workspace-write');
    expect(cmd).toContain("--model 'gpt-5.1-codex'");
    expect(cmd).toContain("--add-dir '/harness/evidence'");
    expect(cmd).not.toMatch(/\bcodex\s+(exec|review)\b/);
  });

  it('AC-AGBACK-004 rejects providers without an interactive adapter instead of falling back', () => {
    expect(() => backendFor('gemini')).toThrow(UnsupportedInteractiveProviderError);
    expect(() => backendFor('mock')).toThrow(/mock/);
  });

  it('AC-AGBACK-005 exposes provider-specific readiness while liveness stays outside adapters', () => {
    expect(providerReadyPattern('claude').test('❯')).toBe(true);
    expect(providerReadyPattern('codex').test('›')).toBe(true);
  });

  it('AC-AGBACK-006 shell-quotes model, session, and writable roots as single arguments', () => {
    const cmd = buildLaunchCommand({
      provider: 'claude', session: "ao-review'; touch /tmp/x; '", cwd: '/rv', purpose: 'reviewer',
      model: "model'; touch /tmp/y; '", additionalDirs: ["/review evidence/security's"],
    });
    expect(cmd).toContain("-n 'ao-review'\\''; touch /tmp/x; '\\'''");
    expect(cmd).toContain("--model 'model'\\''; touch /tmp/y; '\\'''");
    expect(cmd).toContain("--add-dir '/review evidence/security'\\''s'");
  });
});
