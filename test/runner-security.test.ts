import { describe, expect, it } from 'vitest';
import {
  loadRunnerStartup,
  minimalExecutionEnvironment,
} from '../src/runner/security.js';

function safeEnv(): NodeJS.ProcessEnv {
  return {
    HOME: '/home/agentops',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    AGENTOPS_RUNNER_WORKER_ID: 'runner-test-1',
    AGENTOPS_RUNNER_PROVIDER: 'codex',
    AGENTOPS_RUNNER_DATABASE_URL:
      'postgresql://agentops_runner:db-secret@postgres:5432/agentops',
    AGENTOPS_RUNNER_GITHUB_TOKEN: 'github-secret',
    OPENAI_API_KEY: 'provider-secret',
    AGENTOPS_RUNNER_MOUNTS_JSON:
      '[{"source":"agentops-runner-workspace","target":"/workspace","readOnly":false}]',
    AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON: '[]',
    AGENTOPS_RUNNER_OUTBOUND_JSON: JSON.stringify([
      { host: 'postgres', port: 5432 },
      { host: 'github.com', port: 443 },
      { host: 'api.github.com', port: 443 },
      { host: 'api.openai.com', port: 443 },
    ]),
  };
}

describe('runner startup isolation', () => {
  it('accepts one private named volume, zero ports, separated credentials, and controlled outbound', () => {
    const loaded = loadRunnerStartup(safeEnv(), '/app');
    expect(loaded.config).toMatchObject({
      workspaceRoot: '/workspace',
      provider: 'codex',
      publishedPorts: [],
      mounts: [{
        source: 'agentops-runner-workspace',
        target: '/workspace',
        readOnly: false,
      }],
    });
  });

  it.each([
    ['Mac HOME', { HOME: '/Users/operator' }],
    ['development root', { AGENTOPS_WORKSPACE_ROOT: '/workspace/project' }],
    ['SSH agent', { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' }],
    ['Apple Container socket', { CONTAINER_HOST: 'unix:///run/container.sock' }],
    ['control credential', { AGENTOPS_CONTROL_TOKEN: 'control-secret' }],
    ['published port', { AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON: '[8080]' }],
    [
      'host bind mount',
      {
        AGENTOPS_RUNNER_MOUNTS_JSON:
          '[{"source":"/Users/operator","target":"/workspace","readOnly":false}]',
      },
    ],
    [
      'uncontrolled database destination',
      {
        AGENTOPS_RUNNER_OUTBOUND_JSON: JSON.stringify([
          { host: 'github.com', port: 443 },
          { host: 'api.github.com', port: 443 },
        ]),
      },
    ],
    [
      'uncontrolled extra destination',
      {
        AGENTOPS_RUNNER_OUTBOUND_JSON: JSON.stringify([
          { host: 'postgres', port: 5432 },
          { host: 'github.com', port: 443 },
          { host: 'api.github.com', port: 443 },
          { host: 'api.openai.com', port: 443 },
          { host: 'attacker.invalid', port: 443 },
        ]),
      },
    ],
    [
      'missing selected provider destination',
      {
        AGENTOPS_RUNNER_OUTBOUND_JSON: JSON.stringify([
          { host: 'postgres', port: 5432 },
          { host: 'github.com', port: 443 },
          { host: 'api.github.com', port: 443 },
        ]),
      },
    ],
    ['unselected provider credential', { ANTHROPIC_API_KEY: 'other-provider' }],
  ])('fails closed for %s', (_name, patch) => {
    expect(() => loadRunnerStartup({ ...safeEnv(), ...patch }, '/app')).toThrow();
  });

  it('creates a minimal child environment without DB/control/socket credentials', () => {
    const { credentials } = loadRunnerStartup(safeEnv(), '/app');
    const child = minimalExecutionEnvironment(credentials, safeEnv());
    expect(child).toMatchObject({
      HOME: '/home/agentops',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-secret',
      OPENAI_API_KEY: 'provider-secret',
    });
    expect(child).not.toHaveProperty('AGENTOPS_RUNNER_DATABASE_URL');
    expect(child).not.toHaveProperty('AGENTOPS_CONTROL_TOKEN');
    expect(child).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(child).not.toHaveProperty('CONTAINER_HOST');
  });
});
