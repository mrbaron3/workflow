import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTROL_SCHEMA_VERSION,
  ControlSchemaError,
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

  it('deduplicates concurrent webhook and poll enqueue and duplicate deliveries', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const [webhook, poll] = await Promise.all([
      enqueue(store, repo.id, repo.version, 'same-logical-event', 'webhook'),
      enqueue(store, repo.id, repo.version, 'same-logical-event', 'poll'),
    ]);
    expect(new Set([webhook.job.id, poll.job.id]).size).toBe(1);
    expect([webhook.duplicate, poll.duplicate].sort()).toEqual([false, true]);

    const deliveries = await Promise.all(Array.from({ length: 8 }, () =>
      store.receiveWebhook({
        deliveryKey: 'github-delivery-1',
        repository: repo.repository,
        event: 'issues',
        headers: {},
        payload: { action: 'labeled' },
      })));
    expect(new Set(deliveries.map((row) => row.deliveryId)).size).toBe(1);
    expect(deliveries.filter((row) => !row.duplicate)).toHaveLength(1);
  });

  it('recovers interrupted webhook consumer state after process restart', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const receipt = await store.receiveWebhook({
      deliveryKey: 'interrupted-delivery',
      repository: repo.repository,
      event: 'issues',
      headers: {},
      payload: { action: 'labeled' },
    });
    await store.setWebhookConsumers(receipt.deliveryId, repo.id, ['agentops', 'audit']);
    await store.completeWebhookConsumer(receipt.deliveryId, 'agentops');

    const restarted = new PostgresControlStore(pool);
    expect(await restarted.recoverInterruptedWebhooks()).toBe(1);
    const state = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.webhook_deliveries WHERE id = $1',
      [receipt.deliveryId],
    );
    expect(state.rows[0]?.status).toBe('pending');

    await restarted.setWebhookConsumers(receipt.deliveryId, repo.id, ['agentops', 'audit']);
    await restarted.completeWebhookConsumer(receipt.deliveryId, 'audit');
    await restarted.finishWebhookDelivery(receipt.deliveryId, { status: 'processed' });
    const completed = await pool.query<{ status: string }>(
      'SELECT status FROM agentops_control.webhook_deliveries WHERE id = $1',
      [receipt.deliveryId],
    );
    expect(completed.rows[0]?.status).toBe('processed');
  });

  it('persists monitor cursors and rejects a stale registration version', async () => {
    const store = await migratedStore();
    const repo = await registration(store);
    const observedAt = new Date('2026-07-25T01:02:03.000Z');
    await store.saveMonitorCursor({
      registrationId: repo.id,
      monitorKind: 'issue',
      cursor: { issueUpdatedAt: '2026-07-25T01:00:00Z', issueNumber: 12 },
      observedAt,
    });
    await expect(store.getMonitorCursor(repo.id, 'issue')).resolves.toMatchObject({
      cursor: { issueUpdatedAt: '2026-07-25T01:00:00Z', issueNumber: 12 },
      observedAt: observedAt.toISOString(),
    });
    await store.updateRegistration(repo.id, { executionEnabled: false });
    await expect(enqueue(store, repo.id, repo.version, 'stale-registration'))
      .rejects.toThrow(/stale/);
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
    await store.recordBuildDefect({
      buildId,
      defectKey: 'issue-19',
      observationStage: 'release_escape',
      severity: 'high',
      issueUrl: 'https://github.com/mrbaron3/workflow/issues/19',
      summary: 'forwarder accepted a failed relay',
      discoveredAt: new Date(),
    });
    await store.recordBuildDefect({
      buildId,
      defectKey: 'issue-19-followup',
      observationStage: 'release_escape',
      severity: 'medium',
      summary: 'second defect associated with the same released build',
      discoveredAt: new Date(),
    });
    await expect(store.listFalsePassBuilds()).resolves.toEqual([
      { buildId, gateReturned: false, escapeCount: 2 },
    ]);
  });
});
