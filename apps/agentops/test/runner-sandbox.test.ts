import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupRunnerDependencyMount,
  prepareRunnerDependencyMount,
  prepareRunnerDependencyMountTarget,
  runnerSandboxArgs,
  runnerSandboxRoot,
  sandboxedShellCommand,
} from '../src/pipeline/execution/runner-sandbox.js';
import { providerSessionEnvironment } from '../src/pipeline/execution/tmux.js';

const registrationRoot =
  '/workspace/registrations/ca3126a8-b83f-4698-90af-462523880c20';
const activeWorktree =
  `${registrationRoot}/jobs/db837db2-30d7-4788-a56f-00056f5d550e/attempt-1/worktree`;

describe('runner subprocess filesystem sandbox', () => {
  it('hides sibling Registrations and retains only the active Registration', () => {
    const args = runnerSandboxArgs(
      registrationRoot,
      activeWorktree,
      'npm',
      ['test'],
      '/app/node_modules',
    );
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/workspace');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--proc');
    expect(args).toContain('--dev');
    expect(args).toContain('/run');
    expect(args).toContain(registrationRoot);
    expect(args.some((arg, index) => (
      arg === '--bind'
      && args[index + 1] === registrationRoot
      && args[index + 2] === registrationRoot
    ))).toBe(false);
    expect(args).toEqual(expect.arrayContaining([
      '--bind', activeWorktree, activeWorktree,
    ]));
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/home']));
    expect(args).toContain('/app/node_modules');
    expect(args).toContain(
      `${registrationRoot}/jobs/db837db2-30d7-4788-a56f-00056f5d550e/attempt-1/worktree/node_modules`,
    );
    expect(args.slice(-3)).toEqual(['--', 'npm', 'test']);
  });

  it.runIf(
    process.platform === 'linux'
      && process.env.AGENTOPS_RUNNER_PROCESS_SANDBOX === 'bubblewrap-v1',
  )('PR-INTENT hides the live provider credential volume inside the actual sandbox', () => {
    const liveRoot = runnerSandboxRoot(process.env)!;
    const liveWorktree = path.join(
      liveRoot,
      'jobs',
      'db837db2-30d7-4788-a56f-00056f5d550e',
      'attempt-1',
      'worktree',
    );
    fs.mkdirSync(liveWorktree, { recursive: true });
    const result = spawnSync('bwrap', runnerSandboxArgs(
      liveRoot,
      liveWorktree,
      '/bin/sh',
      [
        '-c',
        'test ! -e /run/agentops-credentials && '
          + 'test ! -r /run/agentops-credentials/codex/auth.json',
      ],
    ), {
      cwd: liveRoot,
      encoding: 'utf8',
      env: process.env,
    });
    expect({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      error: undefined,
      stderr: '',
    });
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

  // The /run tmpfs hides the container's read-only credential mount from every
  // subprocess; provider sessions alone get their credential home re-created
  // (writable, for codex session state) with the auth file re-bound read-only.
  // Without this, codex exits at startup ("CODEX_HOME ... does not exist"), the
  // tmux window closes, and the job burns all attempts on "can't find window".
  it('re-binds the provider credential home only when one is passed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      fs.writeFileSync(path.join(home, 'auth.json'), '{}');
      const withHome = runnerSandboxArgs(
        registrationRoot,
        activeWorktree,
        'codex',
        [],
        undefined,
        home,
      );
      expect(withHome).toContain('--dir');
      expect(withHome).toContain(home);
      expect(withHome).toContain(path.join(home, 'auth.json'));
      const withoutHome = runnerSandboxArgs(
        registrationRoot,
        activeWorktree,
        'codex',
        [],
      );
      expect(withoutHome).not.toContain(home);
      expect(withoutHome.join(' ')).not.toContain('auth.json');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds only an explicit same-job evidence sidecar and rejects another job', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sidecar-'));
    const liveRegistration = path.join(
      root,
      'workspace',
      'registrations',
      'ca3126a8-b83f-4698-90af-462523880c20',
    );
    const cwd = path.join(
      liveRegistration,
      'jobs',
      'db837db2-30d7-4788-a56f-00056f5d550e',
      'attempt-1',
      'harness',
      '.harness',
      'review-worktrees',
      'security',
    );
    const sidecar = path.join(
      liveRegistration,
      'jobs',
      'db837db2-30d7-4788-a56f-00056f5d550e',
      'attempt-1',
      'harness',
      '.harness',
      'review-evidence',
      'security',
    );
    const foreign = path.join(
      liveRegistration,
      'jobs',
      'eb837db2-30d7-4788-a56f-00056f5d550e',
      'attempt-1',
      'evidence',
    );
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sidecar, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    try {
      const args = runnerSandboxArgs(
        liveRegistration,
        cwd,
        'codex',
        [],
        undefined,
        undefined,
        [sidecar],
      );
      expect(args).toEqual(expect.arrayContaining(['--bind', sidecar, sidecar]));
      expect(args.join(' ')).not.toContain(foreign);
      expect(() => runnerSandboxArgs(
        liveRegistration,
        cwd,
        'codex',
        [],
        undefined,
        undefined,
        [foreign],
      )).toThrow(/escapes the active job/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives the credential home from CODEX_HOME only under /run/agentops-credentials', () => {
    const base = {
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
      AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
    };
    const inside = sandboxedShellCommand(
      { ...base, CODEX_HOME: '/run/agentops-credentials/codex' },
      activeWorktree,
      'codex',
    );
    expect(inside).toContain("'/run/agentops-credentials/codex'");
    expect(inside).toContain("'/app/node_modules'");
    expect(inside).toContain(`'${activeWorktree}/node_modules'`);
    for (const rejected of ['/etc', '/run/agentops-credentials/../x', 'relative/path']) {
      const command = sandboxedShellCommand(
        { ...base, CODEX_HOME: rejected },
        activeWorktree,
        'codex',
      );
      expect(command).not.toContain(rejected);
    }
  });

  it('rejects dependency mount preparation outside the active Registration', () => {
    expect(() => prepareRunnerDependencyMount({
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
      AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
    }, '/workspace/registrations/other')).toThrow(
      /escapes Registration sandbox/,
    );
  });

  it('quarantines and exactly restores an untrusted node_modules symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-dependency-target-'));
    const target = path.join(root, 'node_modules');
    try {
      fs.symlinkSync('/app/node_modules', target);
      const mount = prepareRunnerDependencyMountTarget(
        '/app/node_modules',
        target,
      );
      expect(fs.lstatSync(target).isDirectory()).toBe(true);
      expect(mount).toMatchObject({
        created: true,
        replacedSymlinkTarget: '/app/node_modules',
      });
      cleanupRunnerDependencyMount(mount);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(target)).toBe('/app/node_modules');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('shell-quotes the provider launch under bubblewrap', () => {
    const command = sandboxedShellCommand({
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
      AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
    }, activeWorktree, "printf '%s' ok");
    expect(command).toContain("'bwrap'");
    expect(command).toContain(`'${registrationRoot}'`);
    expect(command).toContain(`'printf '\\''%s'\\'' ok'`);
  });

  it('keeps only the selected provider token and strips GitHub/DB/socket credentials', () => {
    const previous = process.env;
    process.env = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'provider-secret',
      AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083/',
      AGENTOPS_GITHUB_BROKER_CAPABILITY: 'r'.repeat(43),
      AGENTOPS_GITHUB_BROKER_ROLE: 'runner',
      AGENTOPS_RUNNER_DATABASE_URL: 'postgresql://secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
      AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
      AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
    };
    try {
      expect(providerSessionEnvironment()).toEqual({
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'provider-secret',
        AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
        AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
        AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
        SHELL: '/bin/sh',
      });
    } finally {
      process.env = previous;
    }
  });

  // tmux resolves the passwd login shell when SHELL is unset; a nologin shell kills every
  // window (and the holder session's server with it) at spawn. The environment must always
  // carry a real shell so sessions survive regardless of the image's passwd entry.
  it('pins SHELL to a real shell when unset or nologin, and keeps an operator shell', () => {
    const previous = process.env;
    try {
      process.env = { PATH: '/usr/bin' };
      expect(providerSessionEnvironment().SHELL).toBe('/bin/sh');
      process.env = { PATH: '/usr/bin', SHELL: '/usr/sbin/nologin' };
      expect(providerSessionEnvironment().SHELL).toBe('/bin/sh');
      process.env = { PATH: '/usr/bin', SHELL: '/bin/zsh' };
      expect(providerSessionEnvironment().SHELL).toBe('/bin/zsh');
    } finally {
      process.env = previous;
    }
  });
});
