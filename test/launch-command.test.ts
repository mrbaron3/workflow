/**
 * buildLaunchCommand — the pure `claude` command line for a role session. Extracted so the flag
 * wiring is testable without spawning tmux (the same seam discipline as buildGeneratorPrompt). The
 * key new behaviour: `--model` appears ONLY when a model override is set, so an unset role inherits
 * the user's default model (the pre-existing behaviour) rather than pinning one.
 */
import { describe, it, expect } from 'vitest';
import { buildLaunchCommand } from '../src/pipeline/execution/tmux.js';

describe('buildLaunchCommand', () => {
  it('omits --model when no model is given (inherit the user default)', () => {
    const cmd = buildLaunchCommand({ session: 'ao-x', cwd: '/wt' });
    expect(cmd).not.toContain('--model');
    expect(cmd).toContain('claude -n ao-x');
    expect(cmd).toContain('--permission-mode acceptEdits'); // default mode
    expect(cmd).toContain("--allowedTools 'Read Edit Write'"); // default tools
  });

  it('appends --model <alias> when a model is set', () => {
    const cmd = buildLaunchCommand({ session: 'ao-x', cwd: '/wt', model: 'haiku' });
    expect(cmd).toContain('--model haiku');
    // the flag is additive — the rest of the command is unchanged
    expect(cmd).toContain('--permission-mode acceptEdits');
    expect(cmd).toContain("--allowedTools 'Read Edit Write'");
  });

  it('preserves explicit permissionMode and allowedTools alongside the model', () => {
    const cmd = buildLaunchCommand({
      session: 'ao-eval-y',
      cwd: '/rv',
      allowedTools: ['Read', 'Write', 'Bash'],
      permissionMode: 'default',
      model: 'sonnet',
    });
    expect(cmd).toContain('--permission-mode default');
    expect(cmd).toContain("--allowedTools 'Read Write Bash'");
    expect(cmd).toContain('--model sonnet');
  });
});
