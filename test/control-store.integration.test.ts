import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTROL_SCHEMA_VERSION,
  CONTROL_MIGRATION_LOCK_KEY,
  ControlSchemaError,
  IdempotencyConflictError,
  JobEnvelopeContract,
  LeaseRejectedError,
  PostgresControlStore,
  RepositoryBusyError,
  assertControlSchema,
  migrateControlSchema,
} from '../src/control-store/index.js';

const databaseUrl = process.env.AGENTOPS_TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration('PostgreSQL control store', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 16 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function reset(): Promise<void> {
    await pool.query('DROP SCHEMA IF EXISTS agentops_control CASCADE');
  }

  async function migratedStore(): Promise<PostgresControlStore> {
    await reset();
    expect(await migrateControlSchema(pool)).toBe(CONTROL_SCHEMA_VERSION);
    await assertControlSchema(pool);
    return new PostgresControlStore(pool);
  }

  async function registration(store: PostgresControlStore, suffix = '') {
    return store.createRegistration({
      repository: `mrbaron3/control-store${suffix}`,
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
  }

  async function enqueue(
    store: PostgresControlStore,
    registrationId: string,
    registrationVersion: number,
    key: string,
    sourceKind: 'webhook' | 'poll' = 'webhook',
  ) {
    return store.enqueueJob({
      registrationId,
      registrationVersion,
      source: { kind: sourceKind, key: `${sourceKind}:${key}` },
      idempotencyKey: key,
      jobType: 'github_issue_turn',
      payload: { issueNumber: 12 },
    });
  }

  it('upgrades, verifies after restart, and rejects partial/unknown schema', async () => {
    await reset();
    await expect(assertControlSchema(pool)).rejects.toBeInstanceOf(ControlSchemaError);
    await expect(migrateControlSchema(pool)).resolves.toBe(CONTROL_SCHEMA_VERSION);
    await expect(assertControlSchema(pool)).resolves.toBeUndefined();

    const restartedPool = new Pool({ connectionString: databaseUrl });
    await expect(assertControlSchema(restartedPool)).resolves.toBeUndefined();
    await restartedPool.end();

    await pool.query(
      `UPDATE agentops_control.schema_migrations
          SET version = 99 WHERE version = $1`,
      [CONTROL_SCHEMA_VERSION],
    );
    await expect(assertControlSchema(pool)).rejects.toThrow(/unknown|non-contiguous/);

    await reset();
    await pool.query('CREATE SCHEMA agentops_control');
    await pool.query('CREATE TABLE agentops_control.partial_table(id integer)');
    await expect(migrateControlSchema(pool)).rejects.toThrow(/partial control schema/);
  });

  it('fails closed when the database connection is unavailable', async () => {
    await expect(PostgresControlStore.open({
      connectionString: 'postgresql://postgres:unused@127.0.0.1:1/agentops',
      connectionTimeoutMillis: 200,
    })).rejects.toThrow(/failed closed/);
  });

  it('rolls back every DDL change when a migration fails', async () => {
    await reset();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-bad-migration-'));
    const directory = path.join(root, 'db', 'control-store', 'migrations');
    fs.mkdirSync(directory, { recursive: true });
    const valid = fs.readFileSync(
      path.join(process.cwd(), 'db', 'control-store', 'migrations', '0001_control_store.sql'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(directory, '0001_control_store.sql'),
      `${valid}\nTHIS IS DELIBERATELY INVALID SQL;\n`,
    );
    await expect(migrateControlSchema(pool, { root })).rejects.toThrow(/failed closed/);
    const result = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('agentops_control.repository_registrations')::text AS relation`,
    );
    expect(result.rows[0]?.relation).toBeNull();
  });

  it('serializes fail-closed verification with schema migration ownership', async () => {
    await migratedStore();
    const blocker = await pool.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [CONTROL_MIGRATION_LOCK_KEY]);
      let settled = false;
      const verification = assertControlSchema(pool).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await blocker.query('SELECT pg_advisory_unlock($1)', [CONTROL_MIGRATION_LOCK_KEY]);
      await expect(verification).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [CONTROL_MIGRATION_LOCK_KEY]);
      blocker.release();
    }
  });

  it('deduplicates concurrent webhook and poll enqueue and duplicate deliveries', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const [webhook, poll] = await Promise.all([
      enqueue(store, repo.id, repo.version, 'same-logical-event', 'webhook'),
      enqueue(store, repo.id, repo.version, 'same-logical-event', 'poll'),
    ]);
    expect(new Set([webhook.job.id, poll.job.id]).size).toBe(1);
    expect([webhook.duplicate, poll.duplicate].sort()).toEqual([false, true]);
    expect(JobEnvelopeContract.parse(webhook.job)).toEqual(webhook.job);
    const otherRepo = await registration(store, '-other');
    const other = await enqueue(
      store,
      otherRepo.id,
      otherRepo.version,
      'same-logical-event',
      'webhook',
    );
    expect(other.job.id).not.toBe(webhook.job.id);
    expect(other.job.registrationId).toBe(otherRepo.id);
    await expect(store.enqueueJob({
      registrationId: repo.id,
      registrationVersion: repo.version,
      source: { kind: 'manual', key: 'manual:mismatched-reuse' },
      idempotencyKey: 'same-logical-event',
      jobType: 'github_issue_turn',
      payload: { issueNumber: 13 },
    })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const deliveries = await Promise.all(Array.from({ length: 8 }, () =>
      store.receiveWebhook({
        deliveryKey: 'github-delivery-1',
        repository: repo.repository,
        event: 'issues',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-github-delivery': 'github-delivery-1',
          'x-hub-signature-256': 'sha256=secret',
        },
        payload: { action: 'labeled' },
      })));
    expect(new Set(deliveries.map((row) => row.deliveryId)).size).toBe(1);
    expect(deliveries.filter((row) => !row.duplicate)).toHaveLength(1);
    const stored = await pool.query<{ headers: Record<string, string> }>(
      'SELECT headers FROM agentops_control.webhook_deliveries WHERE id = $1',
      [deliveries[0]!.deliveryId],
    );
    expect(stored.rows[0]?.headers).toEqual({
      'x-github-delivery': 'github-delivery-1',
    });
  });

  it('does not steal live webhook work and recovers only expired ownership after restart', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const receipt = await store.receiveWebhook({
      deliveryKey: 'interrupted-delivery',
      repository: repo.repository,
      event: 'issues',
      headers: {},
      payload: { action: 'labeled' },
    });
    const first = await store.setWebhookConsumers(
      receipt.deliveryId,
      repo.id,
      ['agentops', 'audit'],
      80,
    );
    await store.completeWebhookConsumer(receipt.deliveryId, 'agentops', first.token);
    await expect(store.completeWebhookConsumer(
      receipt.deliveryId,
      'absent',
      first.token,
    )).rejects.toBeInstanceOf(LeaseRejectedError);

    const restarted = new PostgresControlStore(pool);
    expect(await restarted.recoverInterruptedWebhooks()).toBe(0);
    await restarted.heartbeatWebhookProcessing(first.token, 80);
    expect(await restarted.recoverInterruptedWebhooks()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await restarted.recoverInterruptedWebhooks()).toBe(1);
    await expect(restarted.completeWebhookConsumer(
      receipt.deliveryId,
      'audit',
      first.token,
    )).rejects.toBeInstanceOf(LeaseRejectedError);
    const state = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.webhook_deliveries WHERE id = $1',
      [receipt.deliveryId],
    );
    expect(state.rows[0]?.status).toBe('pending');

    const claimed = await Promise.all([
      restarted.claimPendingWebhook(),
      restarted.claimPendingWebhook(),
    ]);
    const second = claimed.find((row) => row !== null);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(second).toMatchObject({
      deliveryId: receipt.deliveryId,
      deliveryKey: 'interrupted-delivery',
      repository: repo.repository,
      payload: { action: 'labeled' },
    });
    await restarted.setClaimedWebhookConsumers(
      second!.token,
      repo.id,
      ['agentops', 'audit'],
    );
    await restarted.completeWebhookConsumer(receipt.deliveryId, 'audit', second!.token);
    await restarted.finishWebhookDelivery(
      receipt.deliveryId,
      { status: 'processed' },
      second!.token,
    );
    const completed = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.webhook_deliveries WHERE id = $1',
      [receipt.deliveryId],
    );
    expect(completed.rows[0]?.status).toBe('processed');
  });

  it('keeps monitor cursors monotonic and releases stale queued single-flight work', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const observedAt = new Date('2026-07-25T01:02:03.000Z');
    await expect(store.saveMonitorCursor({
      registrationId: repo.id,
      monitorKind: 'issue',
      cursor: { issueUpdatedAt: '2026-07-25T01:00:00Z', issueNumber: 12 },
      observedAt,
    })).resolves.toBe(true);
    await expect(store.saveMonitorCursor({
      registrationId: repo.id,
      monitorKind: 'issue',
      cursor: { issueUpdatedAt: '2026-07-24T23:00:00Z', issueNumber: 11 },
      observedAt: new Date('2026-07-25T00:00:00.000Z'),
    })).resolves.toBe(false);
    await expect(store.getMonitorCursor(repo.id, 'issue')).resolves.toMatchObject({
      cursor: { issueUpdatedAt: '2026-07-25T01:00:00Z', issueNumber: 12 },
      observedAt: observedAt.toISOString(),
    });
    const stale = await enqueue(store, repo.id, repo.version, 'stale-registration');
    const updated = await store.updateRegistration(repo.id, { issueMonitorEnabled: false });
    await expect(store.updateRegistration(repo.id, { enabled: undefined }))
      .rejects.toThrow(/patch is empty/);
    const staleStatus = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.jobs WHERE id = $1',
      [stale.job.id],
    );
    expect(staleStatus.rows[0]?.status).toBe('rejected');
    await expect(enqueue(store, repo.id, repo.version, 'stale-registration'))
      .rejects.toThrow(/stale/);
    await expect(enqueue(store, repo.id, updated.version, 'replacement-registration'))
      .resolves.toMatchObject({ duplicate: false });
  });

  it('lets only one competing worker acquire a lease', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    await enqueue(store, repo.id, repo.version, 'lease-race');
    const leases = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.acquireLease({ workerId: `worker-${index}`, durationMs: 10_000 })),
    );
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it('heartbeats, times out, reclaims, and preserves attempt history', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    await enqueue(store, repo.id, repo.version, 'reclaim');
    const first = await store.acquireLease({ workerId: 'worker-a', durationMs: 60 });
    expect(first).not.toBeNull();
    await store.heartbeatLease(first!.token, 120);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(store.heartbeatLease(first!.token, 100))
      .rejects.toBeInstanceOf(LeaseRejectedError);
    expect(await store.reclaimExpiredLeases()).toBe(1);
    const second = await store.acquireLease({ workerId: 'worker-b', durationMs: 1_000 });
    expect(second?.job.id).toBe(first?.job.id);
    expect(second?.attemptNumber).toBe(2);
    const attempts = await pool.query<{ status: string }>(
      `SELECT status FROM agentops_control.job_attempts
        WHERE job_id = $1 ORDER BY attempt_number`,
      [first!.job.id],
    );
    expect(attempts.rows.map((row) => row.status)).toEqual(['timed_out', 'running']);
    const artifactId = await store.linkArtifact({
      jobId: second!.job.id,
      attemptId: second!.attemptId,
      kind: 'test-output',
      uri: 'volume://runner/tests/attempt-2.log',
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
    });
    await store.appendAudit({
      actorType: 'worker',
      actorId: 'worker-b',
      eventType: 'artifact_linked',
      registrationId: repo.id,
      jobId: second!.job.id,
      details: { artifactId },
    });
    const metadata = await pool.query<{ uri: string; size_bytes: string }>(
      'SELECT uri, size_bytes FROM agentops_control.artifact_links WHERE id = $1',
      [artifactId],
    );
    expect(metadata.rows[0]).toMatchObject({
      uri: 'volume://runner/tests/attempt-2.log',
      size_bytes: '1234',
    });
    await store.finishLease(second!.token, { status: 'succeeded' });
  });

  it('rejects an expired leased job after its registration changes', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    await enqueue(store, repo.id, repo.version, 'leased-before-registration-change');
    const lease = await store.acquireLease({ workerId: 'worker-stale', durationMs: 60 });
    expect(lease).not.toBeNull();
    const updated = await store.updateRegistration(repo.id, { prMonitorEnabled: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await store.reclaimExpiredLeases()).toBe(1);
    const stale = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.jobs WHERE id = $1',
      [lease!.job.id],
    );
    expect(stale.rows[0]?.status).toBe('rejected');
    await expect(enqueue(
      store,
      repo.id,
      updated.version,
      'replacement-after-stale-lease',
    )).resolves.toMatchObject({ duplicate: false });
  });

  it('serializes expired lease reclaim with a concurrent registration update', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    await enqueue(store, repo.id, repo.version, 'concurrent-reclaim');
    const lease = await store.acquireLease({
      workerId: 'worker-concurrent-reclaim',
      durationMs: 60,
    });
    expect(lease).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const updater = await pool.connect();
    try {
      await updater.query('BEGIN');
      await updater.query(
        `SELECT id FROM agentops_control.repository_registrations
          WHERE id = $1 FOR UPDATE`,
        [repo.id],
      );
      await updater.query(
        `UPDATE agentops_control.repository_registrations
            SET version = version + 1, pr_monitor_enabled = false
          WHERE id = $1`,
        [repo.id],
      );
      const missed = await updater.query(
        `UPDATE agentops_control.jobs
            SET status = 'rejected'
          WHERE registration_id = $1 AND status = 'queued'`,
        [repo.id],
      );
      expect(missed.rowCount).toBe(0);
      await expect(store.reclaimExpiredLeases()).resolves.toBe(0);
      await updater.query('COMMIT');
    } catch (error) {
      await updater.query('ROLLBACK');
      throw error;
    } finally {
      updater.release();
    }

    await expect(store.reclaimExpiredLeases()).resolves.toBe(1);
    const stale = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.jobs WHERE id = $1',
      [lease!.job.id],
    );
    expect(stale.rows[0]?.status).toBe('rejected');
    const updated = await store.getRegistration(repo.id);
    await expect(enqueue(
      store,
      repo.id,
      updated!.version,
      'replacement-after-concurrent-reclaim',
    )).resolves.toMatchObject({ duplicate: false });
  });

  it('enforces repository single-flight in parallel transactions and at runtime', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const results = await Promise.allSettled([
      enqueue(store, repo.id, repo.version, 'parallel-a', 'webhook'),
      enqueue(store, repo.id, repo.version, 'parallel-b', 'poll'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason)
      .toBeInstanceOf(RepositoryBusyError);
    await expect(enqueue(store, repo.id, repo.version, 'runtime-reject'))
      .rejects.toBeInstanceOf(RepositoryBusyError);
  });

  it('reconciles durable work after a deliberately missed notification', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const queued = await enqueue(store, repo.id, repo.version, 'missed-notify');
    // No LISTEN connection was active when enqueue committed.
    const work = await store.listReconciliationWork();
    expect(work).toEqual([
      expect.objectContaining({
        jobId: queued.job.id,
        registrationId: repo.id,
        repository: repo.repository,
        status: 'queued',
      }),
    ]);
  });

  it('wakes LISTEN clients and still leaves work for periodic reconciliation', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const notified = new Promise<string>((resolve) => {
      void store.listen('agentops_job_wake', (notice) => {
        resolve(notice.payload ?? '');
      }).then(async (stop) => {
        await enqueue(store, repo.id, repo.version, 'listen-notify');
        await notified;
        await stop();
      });
    });
    await expect(notified).resolves.toContain('"table"');
    await expect(store.listReconciliationWork()).resolves.toHaveLength(1);
  });

  it('wakes webhook listeners and lets a restarted router claim pending work', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    let resolveNotice!: (payload: string) => void;
    const notified = new Promise<string>((resolve) => {
      resolveNotice = resolve;
    });
    const stop = await store.listen('agentops_webhook_wake', (notice) => {
      resolveNotice(notice.payload ?? '');
    });
    await store.receiveWebhook({
      deliveryKey: 'pending-across-restart',
      repository: repo.repository,
      event: 'issues',
      headers: {},
      payload: { action: 'opened' },
    });
    await expect(notified).resolves.toContain('webhook_deliveries');
    await stop();

    const restarted = new PostgresControlStore(pool);
    await expect(restarted.claimPendingWebhook()).resolves.toMatchObject({
      deliveryKey: 'pending-across-restart',
      repository: repo.repository,
      payload: { action: 'opened' },
    });
  });

  it('persists multiple release escapes and derives build-level false passes', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const buildId = await store.recordReleasedBuild({
      registrationId: repo.id,
      issueNumber: 12,
      pullRequestNumber: 35,
      revisionId: 'PRREV-0058',
      headSha: '7fa3f65a00000000000000000000000000000000',
      panelApproved: true,
      releasedAt: new Date(),
    });
    const discoveredAt = new Date('2026-07-25T09:00:00.000Z');
    const firstDefectId = await store.recordBuildDefect({
      buildId,
      defectKey: 'issue-19',
      observationStage: 'release_escape',
      severity: 'high',
      issueUrl: 'https://github.com/mrbaron3/workflow/issues/19',
      summary: 'forwarder accepted a failed relay',
      discoveredAt,
      details: { affectedRelay: 'primary' },
    });
    await store.recordBuildDefect({
      buildId,
      defectKey: 'issue-19-followup',
      observationStage: 'release_escape',
      severity: 'medium',
      summary: 'second defect associated with the same released build',
      discoveredAt: new Date('2026-07-25T09:01:00.000Z'),
    });
    await expect(store.listBuildDefects({
      buildId,
      observationStage: 'release_escape',
    })).resolves.toEqual([
      expect.objectContaining({
        id: firstDefectId,
        buildId,
        defectKey: 'issue-19',
        observationStage: 'release_escape',
        severity: 'high',
        issueUrl: 'https://github.com/mrbaron3/workflow/issues/19',
        summary: 'forwarder accepted a failed relay',
        discoveredAt: discoveredAt.toISOString(),
        details: { affectedRelay: 'primary' },
      }),
      expect.objectContaining({
        buildId,
        defectKey: 'issue-19-followup',
        observationStage: 'release_escape',
        severity: 'medium',
        issueUrl: null,
      }),
    ]);

    const nonPanelBuildId = await store.recordReleasedBuild({
      registrationId: repo.id,
      issueNumber: 12,
      revisionId: 'PRREV-NON-PANEL',
      headSha: '8fa3f65a00000000000000000000000000000000',
      panelApproved: false,
      releasedAt: new Date(),
    });
    await store.recordBuildDefect({
      buildId: nonPanelBuildId,
      defectKey: 'issue-non-panel',
      observationStage: 'release_escape',
      severity: 'critical',
      summary: 'escape remains individually queryable regardless of panel state',
      discoveredAt: new Date(),
    });
    await expect(store.listBuildDefects({
      buildId: nonPanelBuildId,
    })).resolves.toEqual([
      expect.objectContaining({
        buildId: nonPanelBuildId,
        defectKey: 'issue-non-panel',
        severity: 'critical',
      }),
    ]);
    await expect(store.listFalsePassBuilds()).resolves.toEqual([
      { buildId, gateReturned: false, escapeCount: 2 },
    ]);
  });
});
