import { describe, expect, it } from 'vitest';
import {
  loadTriagePolicy,
} from '../src/triage/policy.js';
import {
  loadTriageStartup,
  minimalTriageProcessEnvironment,
  minimalTriageProviderEnvironment,
} from '../src/triage/security.js';

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: '/home/agentops',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    AGENTOPS_TRIAGE_WORKER_ID: 'triage-test-1',
    AGENTOPS_TRIAGE_PROVIDER: 'codex',
    AGENTOPS_TRIAGE_PROVIDER_AUTH: 'api-key',
    AGENTOPS_OPERATING_MODE: 'ACTIVE',
    AGENTOPS_TRIAGE_DATABASE_URL:
      'postgresql://agentops_triage:db-secret@postgres:5432/agentops',
    AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083',
    AGENTOPS_GITHUB_BROKER_CAPABILITY: 't'.repeat(43),
    AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
    OPENAI_API_KEY: 'provider-secret-value',
    AGENTOPS_TRIAGE_MOUNTS_JSON: '[]',
    AGENTOPS_TRIAGE_PUBLISHED_PORTS_JSON: '[]',
    AGENTOPS_TRIAGE_OUTBOUND_JSON: JSON.stringify([
      { host: 'postgres', port: 5432 },
      { host: 'github-broker', port: 8083 },
      { host: 'api.github.com', port: 443 },
      { host: 'api.openai.com', port: 443 },
    ]),
  };
}

function safeRuntimeBoundary() {
  return {
    mountInfo: [
      '1 0 254:16 / / ro,relatime - ext4 /dev/vdb rw',
      '2 1 0:3 / /tmp rw,nosuid - tmpfs tmpfs rw',
      '3 1 0:4 / /home/agentops rw,nosuid - tmpfs tmpfs rw',
    ].join('\n'),
    listeningTcpPorts: [],
    visibleContainerSocketPaths: [],
  };
}

describe('triage startup capability boundary', () => {
  it('accepts durable repository registrations with no checkout mount', () => {
    const loaded = loadTriageStartup(
      safeEnvironment(),
      '/app',
      safeRuntimeBoundary(),
    );
    expect(loaded.config.mounts).toEqual([]);
    expect(loaded.credentials.providerAuthentication).toEqual({
      kind: 'api-key',
      provider: 'codex',
      token: 'provider-secret-value',
    });
    expect(loaded.credentials.githubBroker).toEqual({
      url: 'http://github-broker:8083/',
      capability: 't'.repeat(43),
      role: 'triage',
    });
    const providerChild = minimalTriageProviderEnvironment(
      loaded.credentials,
      safeEnvironment(),
    );
    expect(providerChild).toMatchObject({
      OPENAI_API_KEY: 'provider-secret-value',
    });
    expect(providerChild).not.toHaveProperty('GH_TOKEN');
    expect(providerChild).not.toHaveProperty('GITHUB_TOKEN');
    expect(providerChild).not.toHaveProperty('AGENTOPS_TRIAGE_DATABASE_URL');
    const processEnvironment = minimalTriageProcessEnvironment(
      safeEnvironment(),
    );
    expect(processEnvironment).not.toHaveProperty('GH_TOKEN');
    expect(processEnvironment)
      .not.toHaveProperty('AGENTOPS_GITHUB_BROKER_CAPABILITY');
    expect(processEnvironment).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('accepts provider-free MONITOR_ONLY for the typed broker only', () => {
    const environment = safeEnvironment();
    delete environment.OPENAI_API_KEY;
    const loaded = loadTriageStartup({
      ...environment,
      AGENTOPS_OPERATING_MODE: 'MONITOR_ONLY',
      AGENTOPS_TRIAGE_PROVIDER_AUTH: 'none',
      AGENTOPS_TRIAGE_OUTBOUND_JSON: JSON.stringify([
        { host: 'postgres', port: 5432 },
        { host: 'github-broker', port: 8083 },
        { host: 'api.github.com', port: 443 },
      ]),
    }, '/app', safeRuntimeBoundary());
    expect(loaded.config.operatingMode).toBe('MONITOR_ONLY');
    expect(loaded.credentials.providerAuthentication).toEqual({
      kind: 'none',
      provider: 'codex',
    });
  });

  it.each([
    ['development token', {
      AGENTOPS_RUNNER_GITHUB_TOKEN: 'must-not-cross',
    }],
    ['workspace mount', {
      AGENTOPS_TRIAGE_MOUNTS_JSON: JSON.stringify([{
        source: 'development-workspace',
        target: '/workspace',
        readOnly: false,
      }]),
    }],
    ['host port', {
      AGENTOPS_TRIAGE_PUBLISHED_PORTS_JSON: '[8080]',
    }],
    ['extra outbound', {
      AGENTOPS_TRIAGE_OUTBOUND_JSON: JSON.stringify([
        { host: 'postgres', port: 5432 },
        { host: 'github-broker', port: 8083 },
        { host: 'api.github.com', port: 443 },
        { host: 'api.openai.com', port: 443 },
        { host: 'attacker.invalid', port: 443 },
      ]),
    }],
  ])('fails closed for %s', (_name, patch) => {
    expect(() => loadTriageStartup(
      { ...safeEnvironment(), ...patch },
      '/app',
    )).toThrow();
  });

  it('loads labels and context paths as validated policy instead of repo pins', () => {
    const loaded = loadTriagePolicy({
      AGENTOPS_TRIAGE_READY_LABEL: 'human-approved',
      AGENTOPS_TRIAGE_CLAIMED_LABEL: 'automation-owned',
      AGENTOPS_TRIAGE_CANDIDATE_LABEL: 'candidate',
      AGENTOPS_TRIAGE_BLOCKED_LABEL: 'dependency-blocked',
      AGENTOPS_TRIAGE_NEEDS_INFO_LABEL: 'product-question',
      AGENTOPS_TRIAGE_CONTEXT_PATHS_JSON:
        '["PRODUCT.md","architecture/NORTH_STAR.md"]',
    });
    expect(loaded).toMatchObject({
      readyLabel: 'human-approved',
      readyCandidateLabel: 'candidate',
      contextPaths: ['PRODUCT.md', 'architecture/NORTH_STAR.md'],
    });
  });
});
