import { describe, expect, it } from 'vitest';
import {
  runnerSandboxArgs,
  runnerSandboxRoot,
  sandboxedShellCommand,
} from '../src/pipeline/execution/runner-sandbox.js';
import { providerSessionEnvironment } from '../src/pipeline/execution/tmux.js';

const registrationRoot =
  '/workspace/registrations/ca3126a8-b83f-4698-90af-462523880c20';

describe('runner subprocess filesystem sandbox', () => {
  it('hides sibling Registrations and retains only the active Registration', () => {
    const args = runnerSandboxArgs(
      registrationRoot,
      `${registrationRoot}/jobs/db837db2-30d7-4788-a56f-00056f5d550e/attempt-1/worktree`,
      'npm',
      ['test'],
      '/app/node_modules',
    );
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/workspace');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--proc');
    expect(args).toContain('--dev');
    expect(args).toContain(registrationRoot);
    expect(args).toContain('/app/node_modules');
    expect(args).toContain(
      `${registrationRoot}/jobs/db837db2-30d7-4788-a56f-00056f5d550e/attempt-1/worktree/node_modules`,
    );
    expect(args.slice(-3)).toEqual(['--', 'npm', 'test']);
  });

  it('fails closed for a missing/invalid Registration root or escaping cwd', () => {
    expect(() => runnerSandboxRoot({
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
    })).toThrow(/root is absent or invalid/);
    expect(() => runnerSandboxArgs(
      registrationRoot,
      '/workspace/registrations/other',
      'npm',
      ['test'],
    )).toThrow(/escapes Registration sandbox/);
  });

  it('shell-quotes the provider launch under bubblewrap', () => {
    const command = sandboxedShellCommand({
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
    }, `${registrationRoot}/jobs/db837db2-30d7-4788-a56f-00056f5d550e`, "printf '%s' ok");
    expect(command).toContain("'bwrap'");
    expect(command).toContain(`'${registrationRoot}'`);
    expect(command).toContain(`'printf '\\''%s'\\'' ok'`);
  });

  it('keeps only the selected provider token and strips GitHub/DB/socket credentials', () => {
    const previous = process.env;
    process.env = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'provider-secret',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-secret',
      AGENTOPS_RUNNER_DATABASE_URL: 'postgresql://secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
    };
    try {
      expect(providerSessionEnvironment()).toEqual({
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'provider-secret',
        AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
        AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
      });
    } finally {
      process.env = previous;
    }
  });
});
