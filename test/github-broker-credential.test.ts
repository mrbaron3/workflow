import { describe, expect, it, vi } from 'vitest';
import {
  githubBrokerEnvironment,
  githubBrokerVariables,
  loadGitHubBrokerCredential,
  resolveGitHubActorLogin,
  type ActorLoginCommand,
} from '../src/github/credential.js';

function environment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HTTP_PROXY: 'http://control:8082',
    NO_PROXY: 'github-broker',
    AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083',
    AGENTOPS_GITHUB_BROKER_CAPABILITY: 't'.repeat(43),
    AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
  };
}

describe('GitHub App broker client boundary', () => {
  it('loads one exact role capability without creating a GitHub token', () => {
    const credential = loadGitHubBrokerCredential(environment(), 'triage');
    expect(credential).toEqual({
      url: 'http://github-broker:8083/',
      capability: 't'.repeat(43),
      role: 'triage',
    });
    expect(githubBrokerEnvironment(
      credential,
      'acme/widgets',
      environment(),
    )).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/agentops',
      HTTP_PROXY: 'http://control:8082',
      NO_PROXY: 'github-broker',
      AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083/',
      AGENTOPS_GITHUB_BROKER_CAPABILITY: 't'.repeat(43),
      AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
      AGENTOPS_GITHUB_REPOSITORY: 'acme/widgets',
    });
  });

  it.each([
    ['wrong role', { AGENTOPS_GITHUB_BROKER_ROLE: 'runner' }],
    ['external TLS endpoint', {
      AGENTOPS_GITHUB_BROKER_URL: 'https://credentials.example.com:443',
    }],
    ['URL credentials', {
      AGENTOPS_GITHUB_BROKER_URL: 'http://user:pass@github-broker:8083',
    }],
    ['weak capability', {
      AGENTOPS_GITHUB_BROKER_CAPABILITY: 'short',
    }],
    ['legacy PAT', {
      AGENTOPS_TRIAGE_GITHUB_TOKEN: 'legacy-token',
    }],
    ['ambient gh token', {
      GH_TOKEN: 'ambient-token',
    }],
  ])('fails closed for %s', (_name, patch) => {
    expect(() => loadGitHubBrokerCredential(
      { ...environment(), ...patch },
      'triage',
    )).toThrow();
  });

  it('carries the broker variables without redefining a caller environment', () => {
    expect(githubBrokerVariables(
      loadGitHubBrokerCredential(environment(), 'triage'),
    )).toEqual({
      AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083/',
      AGENTOPS_GITHUB_BROKER_CAPABILITY: 't'.repeat(43),
      AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
    });
  });
});

describe('GitHub App actor identity', () => {
  const credential = (): ReturnType<typeof loadGitHubBrokerCredential> =>
    loadGitHubBrokerCredential(environment(), 'triage');

  it('reads the actor the broker already verified, never a token', async () => {
    const run = vi.fn<ActorLoginCommand>(
      async () => ({ stdout: 'agentops-test[bot]\n' }),
    );
    await expect(resolveGitHubActorLogin(credential(), run))
      .resolves.toBe('agentops-test[bot]');
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe('/usr/local/bin/agentops-github-credential-helper');
    expect(args).toEqual(['actor']);
    expect(options.env).toMatchObject({
      AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
    });
  });

  it.each([
    ['a human login', 'operator'],
    ['an empty answer', ''],
    ['an uppercase App slug', 'AgentOps-Test[bot]'],
    ['an unbracketed slug', 'agentops-test'],
  ])('fails closed on %s', async (_name, stdout) => {
    await expect(resolveGitHubActorLogin(
      credential(),
      async () => ({ stdout }),
    )).rejects.toThrow();
  });

  it('fails closed when the broker is unreachable', async () => {
    await expect(resolveGitHubActorLogin(credential(), async () => {
      throw new Error('connect ECONNREFUSED');
    })).rejects.toThrow();
  });
});
