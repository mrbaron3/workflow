import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadRunnerStartup,
  minimalExecutionEnvironment,
  validateCodexAuthFile,
} from '../src/runner/security.js';

function safeEnv(): NodeJS.ProcessEnv {
  return {
    HOME: '/home/agentops',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    AGENTOPS_RUNNER_WORKER_ID: 'runner-test-1',
    AGENTOPS_RUNNER_PROVIDER: 'codex',
    AGENTOPS_RUNNER_PROVIDER_AUTH: 'api-key',
    AGENTOPS_OPERATING_MODE: 'ACTIVE',
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

function safeRuntimeBoundary() {
  return {
    mountInfo: [
      '1 0 254:16 / / ro,relatime - ext4 /dev/vdb rw',
      '2 1 254:32 / /workspace rw,relatime - ext4 /dev/vdc rw',
      '3 1 0:3 / /tmp rw,nosuid - tmpfs tmpfs rw',
    ].join('\n'),
    listeningTcpPorts: [],
    visibleContainerSocketPaths: [],
  };
}

describe('runner startup isolation', () => {
  it('accepts ACTIVE with one private volume and exact provider egress', () => {
    const loaded = loadRunnerStartup(safeEnv(), '/app', safeRuntimeBoundary());
    expect(loaded.config).toMatchObject({
      workspaceRoot: '/workspace',
      provider: 'codex',
      operatingMode: 'ACTIVE',
      publishedPorts: [],
      mounts: [{
        source: 'agentops-runner-workspace',
        target: '/workspace',
        readOnly: false,
      }],
    });
  });

  it('accepts provider-free MONITOR_ONLY with no provider destination', () => {
    const environment = safeEnv();
    delete environment.OPENAI_API_KEY;
    const loaded = loadRunnerStartup(
      {
        ...environment,
        AGENTOPS_OPERATING_MODE: 'MONITOR_ONLY',
        AGENTOPS_RUNNER_PROVIDER_AUTH: 'none',
        AGENTOPS_RUNNER_OUTBOUND_JSON: JSON.stringify([
          { host: 'postgres', port: 5432 },
          { host: 'github.com', port: 443 },
          { host: 'api.github.com', port: 443 },
        ]),
      },
      '/app',
      safeRuntimeBoundary(),
    );
    expect(loaded.config.operatingMode).toBe('MONITOR_ONLY');
    expect(loaded.config.providerAuth).toBe('none');
    expect(loaded.credentials.providerAuthentication).toEqual({
      kind: 'none',
      provider: 'codex',
    });
  });

  it('rejects malformed or structurally incomplete private Codex auth files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ciso07-auth-'));
    const authPath = path.join(directory, 'auth.json');
    try {
      for (const content of [
        'not-json',
        JSON.stringify({ auth_mode: 'chatgpt' }),
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'short' }),
      ]) {
        fs.writeFileSync(authPath, content, { mode: 0o600 });
        expect(() => validateCodexAuthFile(authPath)).toThrow(
          /invalid private credential structure/,
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'writable root filesystem',
      {
        ...safeRuntimeBoundary(),
        mountInfo: safeRuntimeBoundary().mountInfo.replace(
          '/ / ro,relatime',
          '/ / rw,relatime',
        ),
      },
    ],
    [
      'host development bind mount',
      {
        ...safeRuntimeBoundary(),
        mountInfo: `${safeRuntimeBoundary().mountInfo}\n`
          + '4 1 0:4 /Users/operator/Company/Development /source ro - virtiofs host ro',
      },
    ],
    [
      'container socket mount',
      {
        ...safeRuntimeBoundary(),
        mountInfo: `${safeRuntimeBoundary().mountInfo}\n`
          + '4 1 0:4 / /run/container.sock rw - virtiofs container.sock rw',
      },
    ],
    ['listening socket', { ...safeRuntimeBoundary(), listeningTcpPorts: [8080] }],
    [
      'host bind mounted as workspace',
      {
        ...safeRuntimeBoundary(),
        mountInfo: safeRuntimeBoundary().mountInfo.replace(
          '254:32 / /workspace rw,relatime - ext4 /dev/vdc rw',
          '0:42 /Users/operator/repo /workspace rw,relatime - virtiofs host rw',
        ),
      },
    ],
    [
      'unexpected secrets mount',
      {
        ...safeRuntimeBoundary(),
        mountInfo: `${safeRuntimeBoundary().mountInfo}\n`
          + '4 1 254:48 / /secrets rw,relatime - ext4 /dev/vdd rw',
      },
    ],
    [
      'visible management socket',
      {
        ...safeRuntimeBoundary(),
        visibleContainerSocketPaths: ['/run/containerd/containerd.sock'],
      },
    ],
  ])('fails closed for kernel-observed %s', (_name, boundary) => {
    expect(() => loadRunnerStartup(safeEnv(), '/app', boundary)).toThrow();
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
      AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
    });
    expect(child).not.toHaveProperty('AGENTOPS_RUNNER_DATABASE_URL');
    expect(child).not.toHaveProperty('AGENTOPS_CONTROL_TOKEN');
    expect(child).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(child).not.toHaveProperty('CONTAINER_HOST');
    expect(credentials.providerAuthentication).toEqual({
      kind: 'api-key',
      provider: 'codex',
      token: 'provider-secret',
    });
  });
});
