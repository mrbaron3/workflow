import { describe, expect, it, vi } from 'vitest';
import {
  TypedGhTriageClient,
  type GhCommand,
} from '../src/triage/github.js';
import { DEFAULT_TRIAGE_POLICY } from '../src/triage/policy.js';

const githubBroker = {
  url: 'http://github-broker:8083/',
  capability: 't'.repeat(43),
  role: 'triage' as const,
};
const actorLogin = 'agentops-test[bot]';

function endpoint(args: readonly string[]): string {
  return args.find((argument) => argument.startsWith('/repos/')) ?? '';
}

describe('typed GitHub triage boundary', () => {
  it('preserves complete requirements bytes and fails closed instead of truncating', async () => {
    const body = 'b'.repeat(70 * 1024);
    const commentBody = 'c'.repeat(40 * 1024);
    const run: GhCommand = vi.fn(async (args: readonly string[]) => {
      const target = endpoint(args);
      if (target.endsWith('/issues/7')) {
        return { stdout: JSON.stringify({
          number: 7,
          title: 'Complete requirements',
          body,
          state: 'open',
          updated_at: '2026-08-03T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/issues/7',
          labels: [],
          user: { login: 'owner' },
        }) };
      }
      if (target.includes('/issues/7/comments')) {
        return { stdout: JSON.stringify([[{
          id: 9,
          body: commentBody,
          updated_at: '2026-08-03T00:00:01Z',
          html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-9',
          user: { login: 'owner' },
        }]]) };
      }
      if (target.includes('/issues/7/events')) return { stdout: '[[]]' };
      throw new Error(`unexpected typed endpoint ${target}`);
    });
    const client = new TypedGhTriageClient(githubBroker, actorLogin, run);
    const snapshot = await client.snapshot('acme/widgets', 7);
    expect(snapshot.issue.body).toBe(body);
    expect(snapshot.comments[0]?.body).toBe(commentBody);

    const oversized = new TypedGhTriageClient(githubBroker, actorLogin, async (args) => {
      const target = endpoint(args);
      if (target.endsWith('/issues/7')) {
        return { stdout: JSON.stringify({
          number: 7,
          title: 'Oversized',
          body: 'x'.repeat(1_000_001),
          state: 'open',
          updated_at: '2026-08-03T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/issues/7',
          labels: [],
          user: { login: 'owner' },
        }) };
      }
      return { stdout: '[[]]' };
    });
    await expect(oversized.snapshot('acme/widgets', 7)).rejects.toThrow(
      /immutable requirements size limit/,
    );
  });

  it('skips only an explicit 404 for optional context documents', async () => {
    const run: GhCommand = vi.fn(async (args: readonly string[]) => {
      const target = endpoint(args);
      if (target === '/repos/acme/widgets') {
        return { stdout: JSON.stringify({ default_branch: 'main' }) };
      }
      if (target.includes('/contents/README.md')) {
        return {
          stdout: JSON.stringify({
            type: 'file',
            encoding: 'base64',
            content: Buffer.from('# North Star').toString('base64'),
            size: 12,
          }),
        };
      }
      if (target.includes('/contents/AGENTS.md')) {
        throw new Error('gh: Not Found (HTTP 404)');
      }
      if (target.includes('/issues?state=open')) {
        return { stdout: '[]' };
      }
      throw new Error(`unexpected typed endpoint ${target}`);
    });
    const client = new TypedGhTriageClient(
      githubBroker,
      actorLogin,
      run,
    );
    await expect(client.repositoryContext(
      'acme/widgets',
      7,
      ['README.md', 'AGENTS.md'],
    )).resolves.toEqual({
      documents: [{ path: 'README.md', content: '# North Star' }],
      openIssues: [],
    });

    const unavailable = new TypedGhTriageClient(
      githubBroker,
      actorLogin,
      async (args) => {
      const target = endpoint(args);
      if (target === '/repos/acme/widgets') {
        return { stdout: JSON.stringify({ default_branch: 'main' }) };
      }
      throw new Error('network connection reset');
      },
    );
    await expect(unavailable.repositoryContext(
      'acme/widgets',
      7,
      ['README.md'],
    )).rejects.toMatchObject({
      message: 'typed GitHub context-read failed',
      status: null,
    });
  });

  it('lists labels once and creates only missing managed labels', async () => {
    const calls: string[][] = [];
    const run: GhCommand = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (endpoint(args).includes('/labels?per_page=100')) {
        return {
          stdout: JSON.stringify([[{
            name: DEFAULT_TRIAGE_POLICY.blockedLabel,
          }]]),
        };
      }
      if (
        args.includes('--method')
        && args.includes('POST')
        && endpoint(args).endsWith('/labels')
      ) {
        return { stdout: '{}' };
      }
      throw new Error(`unexpected typed endpoint ${endpoint(args)}`);
    });
    const client = new TypedGhTriageClient(
      githubBroker,
      actorLogin,
      run,
    );
    await client.ensureManagedLabels('acme/widgets', DEFAULT_TRIAGE_POLICY);
    const creations = calls.filter((args) =>
      args.includes('--method')
      && args.includes('POST')
      && endpoint(args).endsWith('/labels'));
    expect(creations).toHaveLength(2);
    expect(creations.flat()).toContain(
      `name=${DEFAULT_TRIAGE_POLICY.readyCandidateLabel}`,
    );
    expect(creations.flat()).toContain(
      `name=${DEFAULT_TRIAGE_POLICY.needsInfoLabel}`,
    );
    expect(creations.flat()).not.toContain(
      `name=${DEFAULT_TRIAGE_POLICY.blockedLabel}`,
    );
  });

  it('removes only labels proven present and propagates mutation failures', async () => {
    const calls: string[][] = [];
    const run: GhCommand = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('POST')) {
        return {
          stdout: JSON.stringify([
            { name: DEFAULT_TRIAGE_POLICY.readyCandidateLabel },
            { name: DEFAULT_TRIAGE_POLICY.blockedLabel },
          ]),
        };
      }
      if (args.includes('DELETE')) return { stdout: '{}' };
      throw new Error(`unexpected typed endpoint ${endpoint(args)}`);
    });
    const client = new TypedGhTriageClient(
      githubBroker,
      actorLogin,
      run,
    );
    await expect(client.applyManagedLabel(
      'acme/widgets',
      7,
      DEFAULT_TRIAGE_POLICY.readyCandidateLabel,
      DEFAULT_TRIAGE_POLICY,
    )).resolves.toEqual([DEFAULT_TRIAGE_POLICY.readyCandidateLabel]);
    const removals = calls.filter((args) => args.includes('DELETE'));
    expect(removals).toHaveLength(1);
    expect(endpoint(removals[0]!)).toContain(
      `/labels/${DEFAULT_TRIAGE_POLICY.blockedLabel}`,
    );

    const failing = new TypedGhTriageClient(
      githubBroker,
      actorLogin,
      async (args) => {
      if (args.includes('POST')) {
        return {
          stdout: JSON.stringify([
            { name: DEFAULT_TRIAGE_POLICY.readyCandidateLabel },
            { name: DEFAULT_TRIAGE_POLICY.blockedLabel },
          ]),
        };
      }
      throw new Error('gh: service unavailable (HTTP 503)');
      },
    );
    await expect(failing.applyManagedLabel(
      'acme/widgets',
      7,
      DEFAULT_TRIAGE_POLICY.readyCandidateLabel,
      DEFAULT_TRIAGE_POLICY,
    )).rejects.toMatchObject({
      message: 'typed GitHub label-remove failed',
      status: 503,
    });
  });
});
