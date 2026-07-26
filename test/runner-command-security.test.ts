import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandEnvironment,
  runCommand,
} from '../src/pipeline/execution/command.js';
import { commitBuild } from '../src/pipeline/execution/worktree.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('isolated-runner trusted command boundary', () => {
  it('gives GitHub and local-git subprocesses disjoint minimal credentials', () => {
    const source = {
      PATH: '/usr/bin:/bin',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-secret',
      GIT_ASKPASS: '/usr/local/bin/agentops-git-askpass',
      OPENAI_API_KEY: 'provider-secret',
      ANTHROPIC_API_KEY: 'other-provider-secret',
      CODEX_HOME: '/run/agentops-credentials/codex',
      AGENTOPS_RUNNER_DATABASE_URL: 'postgresql://db-secret',
    };
    expect(commandEnvironment('github', source)).toMatchObject({
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-secret',
    });
    expect(commandEnvironment('github', source)).not.toHaveProperty('OPENAI_API_KEY');
    expect(commandEnvironment('github', source)).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(commandEnvironment('github', source)).not.toHaveProperty('CODEX_HOME');
    expect(commandEnvironment('github', source))
      .not.toHaveProperty('AGENTOPS_RUNNER_DATABASE_URL');
    expect(commandEnvironment('none', source)).not.toHaveProperty('GH_TOKEN');
    expect(commandEnvironment('none', source)).not.toHaveProperty('GIT_ASKPASS');
  });

  it('disables provider-written git hooks for harness-owned commits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-hook-boundary-'));
    roots.push(root);
    execFileSync('git', ['init', root]);
    const hooks = path.join(root, '.malicious-hooks');
    fs.mkdirSync(hooks);
    const marker = path.join(root, 'hook-executed');
    const hook = path.join(hooks, 'post-commit');
    fs.writeFileSync(hook, `#!/bin/sh\nprintf leaked > '${marker}'\n`, {
      mode: 0o755,
    });
    execFileSync('git', ['-C', root, 'config', 'core.hooksPath', hooks]);
    fs.writeFileSync(path.join(root, 'change.txt'), 'safe\n');

    expect(commitBuild(root, 'hook isolation')).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('kills a permanently blocked command at its explicit deadline', () => {
    expect(() => runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      { timeoutMs: 25, credentials: 'none' },
    )).toThrow(/timed out|ETIMEDOUT|failed/i);
  });
});
