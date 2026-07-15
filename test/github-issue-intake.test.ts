/** FEAT-016 — deterministic, store-first GitHub Issue polling and claim. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/store.js';
import { DB, GithubIssueSnapshot } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  IntakeRepositoryMismatchError,
  githubIntakeKey,
  pollAndClaimGithubIssues,
  type GithubIssueRunner,
} from '../src/intake/github-issues.js';

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-intake-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function config(repository = 'acme/theme'): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    intake: { backend: 'github', repository, readyLabel: 'ready', claimedLabel: 'agent-claimed' },
  };
}

function snapshot(
  number: number,
  patch: Partial<ReturnType<typeof GithubIssueSnapshot.parse>> = {},
): ReturnType<typeof GithubIssueSnapshot.parse> {
  return GithubIssueSnapshot.parse({
    repository: 'acme/theme', number, externalId: `I_${number}`, title: `Issue ${number}`,
    body: `Original body ${number}`, url: `https://github.com/acme/theme/issues/${number}`,
    labels: ['ready'], state: 'open', sourceUpdatedAt: '2026-07-14T00:00:00.000Z',
    snapshotAt: '2026-07-14T01:00:00.000Z', ...patch,
  });
}

class FakeRunner implements GithubIssueRunner {
  issues: ReturnType<typeof GithubIssueSnapshot.parse>[] = [];
  claims: number[] = [];
  failClaims = 0;
  listReadyIssues(): ReturnType<typeof GithubIssueSnapshot.parse>[] {
    return this.issues;
  }
  claimIssue(_repository: string, issueNumber: number): void {
    this.claims.push(issueNumber);
    if (this.failClaims-- > 0) throw new Error('simulated GitHub label failure');
  }
}

describe('GitHub Issue intake', () => {
  it('AC-GHINTAKE-001 filters explicit open+ready issues and processes them in number order', () => {
    const store = new Store(root());
    const runner = new FakeRunner();
    runner.issues = [
      snapshot(9),
      snapshot(2),
      snapshot(3, { state: 'closed' }),
      snapshot(4, { labels: ['triage'] }),
    ];

    const result = pollAndClaimGithubIssues(store, config(), runner);
    expect(result.map((r) => r.issueNumber)).toEqual([2, 9]);
    expect(runner.claims).toEqual([2, 9]);
    expect(store.db.intakeRecords.map((r) => r.snapshot.number)).toEqual([2, 9]);
  });

  it('AC-GHINTAKE-002 persists repository identity, immutable source fields, and claimed state', () => {
    const dir = root();
    const store = new Store(dir);
    const runner = new FakeRunner();
    runner.issues = [snapshot(42)];
    pollAndClaimGithubIssues(store, config(), runner);

    const reloaded = new Store(dir);
    const record = reloaded.db.intakeRecords[0]!;
    expect(record.intakeKey).toBe(githubIntakeKey('acme/theme', 42));
    expect(record.snapshot).toMatchObject({
      repository: 'acme/theme', number: 42, title: 'Issue 42', body: 'Original body 42', labels: ['ready'],
    });
    expect(record.status).toBe('claimed');
    expect(record.claimedAt).not.toBeNull();
  });

  it('AC-GHINTAKE-003 duplicate poll and store reload do not duplicate records, counters, or claims', () => {
    const dir = root();
    const runner = new FakeRunner();
    runner.issues = [snapshot(42)];
    const store = new Store(dir);
    pollAndClaimGithubIssues(store, config(), runner);
    const counter = store.db.counters.INTAKE;
    pollAndClaimGithubIssues(store, config(), runner);
    pollAndClaimGithubIssues(new Store(dir), config(), runner);

    expect(new Store(dir).db.intakeRecords).toHaveLength(1);
    expect(new Store(dir).db.counters.INTAKE).toBe(counter);
    expect(runner.claims).toEqual([42]);
  });

  it('AC-GHINTAKE-004 saves claim-pending before an external failure and retries the same record', () => {
    const dir = root();
    const runner = new FakeRunner();
    runner.issues = [snapshot(7)];
    runner.failClaims = 1;
    expect(() => pollAndClaimGithubIssues(new Store(dir), config(), runner)).toThrow(/label failure/);

    const pending = new Store(dir);
    expect(pending.db.intakeRecords).toHaveLength(1);
    expect(pending.db.intakeRecords[0]!.status).toBe('claim-pending');
    const original = pending.db.intakeRecords[0]!.snapshot;

    pollAndClaimGithubIssues(pending, config(), runner);
    const claimed = new Store(dir).db.intakeRecords[0]!;
    expect(claimed.id).toBe(pending.db.intakeRecords[0]!.id);
    expect(claimed.snapshot).toEqual(original);
    expect(claimed.status).toBe('claimed');
    expect(runner.claims).toEqual([7, 7]);
  });

  it('AC-GHINTAKE-005 keys the same issue number by repository and blocks repository mixing in one store', () => {
    expect(githubIntakeKey('acme/a', 42)).not.toBe(githubIntakeKey('acme/b', 42));
    const store = new Store(root());
    const runner = new FakeRunner();
    runner.issues = [snapshot(42)];
    pollAndClaimGithubIssues(store, config('acme/theme'), runner);
    expect(() => pollAndClaimGithubIssues(store, config('acme/other'), runner)).toThrow(IntakeRepositoryMismatchError);
    expect(store.db.intakeRecords).toHaveLength(1);
  });

  it('AC-GHINTAKE-006 never overwrites the first snapshot when a claimed issue reappears edited', () => {
    const store = new Store(root());
    const runner = new FakeRunner();
    runner.issues = [snapshot(42)];
    pollAndClaimGithubIssues(store, config(), runner);
    runner.issues = [snapshot(42, { title: 'Edited title', body: 'Edited body', labels: ['ready', 'changed'] })];
    pollAndClaimGithubIssues(store, config(), runner);

    expect(store.db.intakeRecords[0]!.snapshot.title).toBe('Issue 42');
    expect(store.db.intakeRecords[0]!.snapshot.body).toBe('Original body 42');
    expect(store.db.intakeRecords[0]!.snapshot.labels).toEqual(['ready']);
  });

  it('old DBs load with an empty additive intake collection', () => {
    expect(DB.parse({ version: 1 }).intakeRecords).toEqual([]);
  });
});
