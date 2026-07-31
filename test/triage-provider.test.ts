import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliTriageProvider,
  type TriageProviderProcessRunner,
} from '../src/triage/provider.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Codex triage provider runtime boundary', () => {
  it('projects only auth.json into a writable invocation home and removes it', async () => {
    const credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-auth-'));
    roots.push(credentialRoot);
    fs.writeFileSync(
      path.join(credentialRoot, 'auth.json'),
      '{"tokens":{"access_token":"test-only"}}\n',
      { mode: 0o400 },
    );
    fs.chmodSync(credentialRoot, 0o500);

    let invocationHome = '';
    let invocationAuth = '';
    let invocationHomeMode = 0;
    let invocationAuthMode = 0;
    const runProcess: TriageProviderProcessRunner = async (
      command,
      args,
      _prompt,
      _cwd,
      environment,
    ) => {
      expect(command).toBe('codex');
      invocationHome = environment.CODEX_HOME ?? '';
      invocationAuth = fs.readFileSync(
        path.join(invocationHome, 'auth.json'),
        'utf8',
      );
      invocationHomeMode = fs.statSync(invocationHome).mode & 0o777;
      invocationAuthMode =
        fs.statSync(path.join(invocationHome, 'auth.json')).mode & 0o777;
      const outputFlag = args.indexOf('--output-last-message');
      fs.writeFileSync(args[outputFlag + 1]!, JSON.stringify({
        schemaVersion: 1,
        type: 'documentation',
        northStarAlignment: 'aligned',
        readiness: 'ready_candidate',
        priority: 'p2',
        summary: '境界が明確なdocumentation issueです。',
        rationale: ['依存関係と不足情報がありません。'],
        dependencies: [],
        duplicateCandidates: [],
        missingInformation: [],
      }));
      return { status: 0, stdout: '', stderr: '' };
    };
    const provider = new CliTriageProvider(
      'codex',
      {
        HOME: '/home/agentops',
        PATH: '/usr/bin:/bin',
        CODEX_HOME: credentialRoot,
      },
      process.cwd(),
      undefined,
      30_000,
      runProcess,
    );

    await expect(provider.analyze({
      repository: 'acme/widgets',
      snapshot: {
        actorLogin: 'agentops',
        issue: {
          number: 4,
          title: 'Document the public contract',
          body: 'WHAT and acceptance boundary are explicit.',
          state: 'open',
          updatedAt: '2026-07-31T00:00:00.000Z',
          url: 'https://github.com/acme/widgets/issues/4',
          labels: [],
          author: 'owner',
          isPullRequest: false,
        },
        comments: [],
      },
      context: { documents: [], openIssues: [] },
    })).resolves.toMatchObject({
      schemaVersion: 1,
      readiness: 'ready_candidate',
    });
    expect(invocationHome).not.toBe(credentialRoot);
    expect(invocationHome).toContain(`${path.sep}agentops-triage-`);
    expect(invocationAuth).toBe('{"tokens":{"access_token":"test-only"}}\n');
    expect(invocationHomeMode).toBe(0o700);
    expect(invocationAuthMode).toBe(0o600);
    expect(fs.existsSync(invocationHome)).toBe(false);
    expect(fs.readFileSync(
      path.join(credentialRoot, 'auth.json'),
      'utf8',
    )).toBe('{"tokens":{"access_token":"test-only"}}\n');
    expect(fs.readdirSync(credentialRoot)).toEqual(['auth.json']);
  });
});
