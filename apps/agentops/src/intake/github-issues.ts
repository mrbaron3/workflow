/** Deterministic GitHub Issue polling + store-first claim (FEAT-016 / ADR-0008). */
import {
  GithubIssueSnapshot,
  IntakeRecord,
  type GithubIssueSnapshot as GithubIssueSnapshotType,
  type IntakeRecord as IntakeRecordType,
} from '../domain/schema.js';
import type { HarnessConfig, IntakeConfig } from '../config.js';
import { Store, nowISO } from '../store/store.js';
import { runCommand } from '../pipeline/execution/command.js';

export interface ResolvedGithubIntakeConfig {
  repository: string;
  readyLabel: string;
  claimedLabel: string;
}

export function resolveGithubIntakeConfig(config: HarnessConfig): ResolvedGithubIntakeConfig | null {
  const raw = config.intake;
  if (!raw) return null;
  if (raw.backend !== 'github') throw new Error(`Unsupported intake backend: ${String((raw as IntakeConfig).backend)}`);
  if (typeof raw.repository !== 'string' || raw.repository.trim() === '') {
    throw new Error('GitHub intake repository must be a non-empty owner/name');
  }
  const readyLabel = raw.readyLabel ?? 'ready';
  const claimedLabel = raw.claimedLabel ?? 'agent-claimed';
  if (!readyLabel || !claimedLabel) throw new Error('GitHub intake labels must be non-empty');
  return { repository: raw.repository, readyLabel, claimedLabel };
}

export function githubIntakeKey(repository: string, issueNumber: number): string {
  return `github:${encodeURIComponent(repository)}:${issueNumber}`;
}

export interface GithubIssueRunner {
  listReadyIssues(repository: string, readyLabel: string): GithubIssueSnapshotType[];
  /** Read one Source Issue even after its ready label was consumed by a claim. */
  viewIssue?(repository: string, issueNumber: number): GithubIssueSnapshotType;
  claimIssue(repository: string, issueNumber: number, readyLabel: string, claimedLabel: string): void;
}

export interface IntakePollResult {
  intakeKey: string;
  issueNumber: number;
  status: IntakeRecordType['status'];
  created: boolean;
}

export class IntakeRepositoryMismatchError extends Error {
  constructor(readonly storedRepositories: string[], readonly requestedRepository: string) {
    super(
      `Intake repository mismatch: store has ${storedRepositories.join(', ')}, requested ${requestedRepository}`,
    );
    this.name = 'IntakeRepositoryMismatchError';
  }
}

function claimPending(
  store: Store,
  record: IntakeRecordType,
  config: ResolvedGithubIntakeConfig,
  runner: GithubIssueRunner,
  beforeClaim?: () => Promise<void>,
): Promise<void> {
  return claimPendingAsync(store, record, config, runner, beforeClaim);
}

async function claimPendingAsync(
  store: Store,
  record: IntakeRecordType,
  config: ResolvedGithubIntakeConfig,
  runner: GithubIssueRunner,
  beforeClaim?: () => Promise<void>,
): Promise<void> {
  await beforeClaim?.();
  runner.claimIssue(config.repository, record.snapshot.number, config.readyLabel, config.claimedLabel);
  record.status = 'claimed';
  record.claimedAt = nowISO();
  record.updatedAt = record.claimedAt;
  store.save();
}

/**
 * Claim ready issues in stable order. The pending record is saved before external mutation, so
 * a crash/API failure resumes from the store instead of losing an issue whose label moved.
 */
export function pollAndClaimGithubIssues(
  store: Store,
  harnessConfig: HarnessConfig,
  runner: GithubIssueRunner,
  beforeClaim?: () => Promise<void>,
): Promise<IntakePollResult[]> {
  return pollAndClaimGithubIssuesAsync(
    store,
    harnessConfig,
    runner,
    beforeClaim,
  );
}

async function pollAndClaimGithubIssuesAsync(
  store: Store,
  harnessConfig: HarnessConfig,
  runner: GithubIssueRunner,
  beforeClaim?: () => Promise<void>,
): Promise<IntakePollResult[]> {
  const config = resolveGithubIntakeConfig(harnessConfig);
  if (!config) return [];

  const repositories = [...new Set(store.db.intakeRecords.map((record) => record.snapshot.repository))];
  if (repositories.some((repository) => repository !== config.repository)) {
    throw new IntakeRepositoryMismatchError(repositories, config.repository);
  }

  const results: IntakePollResult[] = [];

  // Retry durable pending work even if a partially-applied external label change makes the source
  // disappear from the ready query.
  for (const pending of store.db.intakeRecords.filter((record) => record.status === 'claim-pending')) {
    await claimPending(store, pending, config, runner, beforeClaim);
    results.push({ intakeKey: pending.intakeKey, issueNumber: pending.snapshot.number, status: pending.status, created: false });
  }

  const snapshots = runner
    .listReadyIssues(config.repository, config.readyLabel)
    .map((raw) => GithubIssueSnapshot.parse(raw))
    .filter((snapshot) => {
      if (snapshot.repository !== config.repository) {
        throw new Error(
          `GitHub intake adapter returned ${snapshot.repository} while polling ${config.repository}`,
        );
      }
      return snapshot.state === 'open' && snapshot.labels.includes(config.readyLabel);
    })
    .sort((a, b) => a.number - b.number);

  for (const snapshot of snapshots) {
    const key = githubIntakeKey(snapshot.repository, snapshot.number);
    const existing = store.intakeByKey(key);
    if (existing) {
      if (!results.some((result) => result.intakeKey === key)) {
        results.push({ intakeKey: key, issueNumber: snapshot.number, status: existing.status, created: false });
      }
      continue; // immutable first snapshot; a claimed record never calls external claim again
    }

    const timestamp = nowISO();
    const record = store.addIntakeRecord(
      IntakeRecord.parse({
        id: store.nextId('INTAKE'),
        intakeKey: key,
        provider: 'github',
        snapshot,
        status: 'claim-pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    store.save(); // store-first durability: MUST precede runner.claimIssue
    await claimPending(store, record, config, runner, beforeClaim);
    results.push({ intakeKey: key, issueNumber: snapshot.number, status: record.status, created: true });
  }
  return results;
}

function gh(cwd: string, args: string[]): string {
  return runCommand('gh', args, cwd);
}

/** Real GitHub adapter; unit tests use GithubIssueRunner fakes and never access the network. */
export function realGithubIssueRunner(cwd: string): GithubIssueRunner {
  const snapshot = (
    repository: string,
    issue: {
      number: number;
      id: string;
      title: string;
      body: string | null;
      url: string;
      labels: Array<{ name: string }>;
      updatedAt: string;
      state: string;
    },
  ): GithubIssueSnapshotType => GithubIssueSnapshot.parse({
    repository,
    number: issue.number,
    externalId: issue.id,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.url,
    labels: issue.labels.map((label) => label.name),
    state: issue.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    sourceUpdatedAt: issue.updatedAt,
    snapshotAt: nowISO(),
  });
  return {
    listReadyIssues(repository, readyLabel) {
      const raw = JSON.parse(
        gh(cwd, [
          'issue', 'list', '--repo', repository, '--state', 'open', '--label', readyLabel,
          '--limit', '100', '--json', 'number,id,title,body,url,labels,updatedAt,state',
        ]),
      ) as Array<{
        number: number;
        id: string;
        title: string;
        body: string | null;
        url: string;
        labels: Array<{ name: string }>;
        updatedAt: string;
        state: string;
      }>;
      return raw.map((issue) => snapshot(repository, issue));
    },
    viewIssue(repository, issueNumber) {
      const raw = JSON.parse(
        gh(cwd, [
          'issue', 'view', String(issueNumber), '--repo', repository,
          '--json', 'number,id,title,body,url,labels,updatedAt,state',
        ]),
      ) as {
        number: number;
        id: string;
        title: string;
        body: string | null;
        url: string;
        labels: Array<{ name: string }>;
        updatedAt: string;
        state: string;
      };
      if (raw.number !== issueNumber) {
        throw new Error(
          `GitHub returned Issue #${raw.number} while reading #${issueNumber}`,
        );
      }
      return snapshot(repository, raw);
    },
    claimIssue(repository, issueNumber, readyLabel, claimedLabel) {
      const viewed = JSON.parse(
        gh(cwd, ['issue', 'view', String(issueNumber), '--repo', repository, '--json', 'labels']),
      ) as { labels: Array<{ name: string }> };
      const labels = new Set(viewed.labels.map((label) => label.name));
      const args = ['issue', 'edit', String(issueNumber), '--repo', repository];
      if (labels.has(readyLabel)) args.push('--remove-label', readyLabel);
      if (!labels.has(claimedLabel)) args.push('--add-label', claimedLabel);
      if (args.length > 6) gh(cwd, args); // already claimed is a successful idempotent no-op
    },
  };
}
