/** FEAT-014 — provider-neutral interactive request mapped by CLI-specific adapters. */
import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, repositoryTrustRoot } from '../src/pipeline/execution/tmux.js';
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

  it('trusts only this session directory so the codex trust prompt never eats the first prompt', () => {
    const cmd = buildLaunchCommand({
      provider: 'codex', session: 'ao-plan', cwd: '/workspace/registrations/r1/jobs/j1/worktree',
      purpose: 'planner',
    });
    expect(cmd).toContain(
      `-c 'projects."/workspace/registrations/r1/jobs/j1/worktree".trust_level="trusted"'`,
    );
    // Codex keys trust by git repository root, so a worktree session must trust that root too.
    const worktreeCmd = buildLaunchCommand({
      provider: 'codex', session: 'ao-plan', cwd: '/workspace/registrations/r1/jobs/j1/worktree',
      purpose: 'planner', trustRoots: ['/workspace/registrations/r1'],
    });
    expect(worktreeCmd).toContain(`-c 'projects."/workspace/registrations/r1".trust_level="trusted"'`);
    const deduped = buildLaunchCommand({
      provider: 'codex', session: 'ao-plan', cwd: '/repo', purpose: 'planner', trustRoots: ['/repo'],
    });
    expect(deduped.match(/trust_level/g)).toHaveLength(1);
    // Repository-supplied hooks must stay gated by persisted hook trust.
    expect(cmd).not.toContain('--dangerously-bypass-hook-trust');
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const claude = buildLaunchCommand({
      provider: 'claude', session: 'ao-gen', cwd: '/wt', purpose: 'generator',
    });
    expect(claude).not.toContain('trust_level');
  });

  // Measured in the runner container: a harness worktree reports the bare mirror as its common
  // dir, and codex named that mirror's parent as the repository root it keys trust by. An ordinary
  // checkout reports <repo>/.git, whose parent is the repo itself — one rule covers both.
  it('derives the repository root codex keys trust by from the git common dir', () => {
    expect(repositoryTrustRoot('/workspace/registrations/r1/repository.git'))
      .toBe('/workspace/registrations/r1');
    expect(repositoryTrustRoot('/home/me/project/.git')).toBe('/home/me/project');
    expect(repositoryTrustRoot(null)).toBeNull();
    expect(repositoryTrustRoot('/')).toBeNull();
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
