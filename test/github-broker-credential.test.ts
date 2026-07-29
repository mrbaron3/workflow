import { describe, expect, it } from 'vitest';
import {
  githubBrokerEnvironment,
  loadGitHubBrokerCredential,
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
    expect(githubBrokerEnvironment(credential, environment())).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/agentops',
      HTTP_PROXY: 'http://control:8082',
      NO_PROXY: 'github-broker',
      AGENTOPS_GITHUB_BROKER_URL: 'http://github-broker:8083/',
      AGENTOPS_GITHUB_BROKER_CAPABILITY: 't'.repeat(43),
      AGENTOPS_GITHUB_BROKER_ROLE: 'triage',
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
});
