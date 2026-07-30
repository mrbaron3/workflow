import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_SCHEMA_VERSION,
  CONTROL_MIGRATION_LOCK_KEY,
  ControlSchemaError,
  IdempotencyConflictError,
  JobEnvelopeContract,
  LeaseRejectedError,
  OperatingModeError,
  PostgresControlStore,
  RepositoryBusyError,
  assertControlSchema,
  migrateControlSchema,
} from '../src/control-store/index.js';
import type { AgentOpsRunnerAdapter } from '../src/runner/adapter.js';
import { IsolatedRunnerService } from '../src/runner/service.js';
import {
  RunnerWorkspaceManager,
  type WorkspaceCommandRunner,
} from '../src/runner/workspace.js';

// Each test in this file rebuilds the control schema against a real PostgreSQL
// before doing its own work, so the default 5s per-test budget leaves no room
// for a loaded CI runner: one test was observed timing out at 5009ms while its
// neighbours in the same run took 4-6x their local duration. The bound sits
// above the lock timeout in reset() so a genuine lock wait fails naming itself
// rather than as an expired test.
vi.setConfig({ testTimeout: 20_000 });

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

  // Every test rebuilds the schema, so this DROP is the one statement in the
  // suite that never means to wait: if it cannot take its locks, a previous
  // test left a connection holding them. An unbounded wait surfaces as an
  // opaque "test timed out", which says nothing about the cause — a bounded one
  // fails naming the lock. The bound is generous so ordinary CI slowness never
  // reaches it. The three statements travel as one simple query, which
  // PostgreSQL wraps in an implicit transaction, so the bound never outlives
  // this call on a pooled connection: the trailing reset restores it, and a
  // failing DROP rolls the SET back with everything else.
  async function reset(): Promise<void> {
    await pool.query(
      `SET lock_timeout = '10s';
       DROP SCHEMA IF EXISTS agentops_control CASCADE;
       SET lock_timeout = DEFAULT;`,
    );
  }

  async function migratedStore(): Promise<PostgresControlStore> {
    await reset();
    expect(await migrateControlSchema(pool)).toBe(CONTROL_SCHEMA_VERSION);
    await pool.query(
      `UPDATE agentops_control.lifecycle_state
          SET mode = 'ACTIVE', generation = generation + 1,
              updated_at = clock_timestamp()
        WHERE singleton`,
    );
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

  async function enqueueRunner(
    store: PostgresControlStore,
    registrationId: string,
    registrationVersion: number,
    key: string,
  ) {
    return store.enqueueJob({
      registrationId,
      registrationVersion,
      source: { kind: 'manual', key },
      idempotencyKey: key,
      jobType: 'agentops.runner',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'mrbaron3', name: `control-store${key}` },
        event: { kind: 'issue', number: 14, action: 'labeled' },
        target: { baseRef: 'refs/heads/main' },
        execution: {
          mode: 'development_turn',
          requiredChecks: ['test'],
          mergeMethod: 'squash',
          readyLabel: 'ready',
          claimedLabel: 'agent-claimed',
        },
        artifacts: [],
      },
    });
  }

  async function insertMonitorBrokerRequest(input: {
    registrationId: string;
    registrationVersion: number;
    repository?: string;
    kind?: 'issue' | 'pull_request';
    cursor?: { updatedAfter: string };
  }): Promise<string> {
    const id = randomUUID();
    const cursor = input.cursor ?? { updatedAfter: '' };
    const digest = createHash('sha256')
      .update(JSON.stringify(cursor))
      .digest('hex');
    await pool.query(
      `INSERT INTO agentops_control.monitor_broker_requests(
         id, registration_id, registration_version, repository,
         monitor_kind, cursor, cursor_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.registrationId,
        input.registrationVersion,
        input.repository ?? 'mrbaron3/workflow',
        input.kind ?? 'issue',
        cursor,
        digest,
      ],
    );
    return id;
  }

  it('atomically fences racing enqueue and lease acquisition when drain commits', async () => {
    const store = await migratedStore();
    const registered = await registration(store, '-mode-fence');
    await enqueueRunner(store, registered.id, registered.version, 'before-drain');
    let blocker: PoolClient | undefined;
    let blockerTransactionOpen = false;
    const pending: Promise<unknown>[] = [];
    try {
      blocker = await pool.connect();
      await blocker.query('BEGIN');
      blockerTransactionOpen = true;
      await blocker.query(
        `UPDATE agentops_control.lifecycle_state
            SET mode = 'DRAINING', generation = generation + 1,
                updated_at = clock_timestamp()
          WHERE singleton`,
      );
      let leaseSettled = false;
      let enqueueSettled = false;
      const lease = store.acquireLease({
        workerId: 'mode-fenced-runner',
        durationMs: 30_000,
        jobType: 'agentops.runner',
      }).finally(() => {
        leaseSettled = true;
      });
      // Mark an unexpected rejection handled immediately; the assertion below
      // still observes the original promise after the blocker commits.
      void lease.catch(() => undefined);
      pending.push(lease);
      const enqueue = enqueueRunner(
        store,
        registered.id,
        registered.version,
        'after-drain',
      ).then(
        () => null,
        (error: unknown) => error,
      ).finally(() => {
        enqueueSettled = true;
      });
      pending.push(enqueue);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect({ leaseSettled, enqueueSettled }).toEqual({
        leaseSettled: false,
        enqueueSettled: false,
      });
      await blocker.query('COMMIT');
      blockerTransactionOpen = false;
      await expect(lease).resolves.toBeNull();
      await expect(enqueue).resolves.toBeInstanceOf(OperatingModeError);
    } finally {
      let cleanupError: unknown;
      if (blocker) {
        if (blockerTransactionOpen) {
          try {
            await blocker.query('ROLLBACK');
          } catch (error) {
            cleanupError = error;
          }
        }
        blocker.release(cleanupError instanceof Error ? cleanupError : undefined);
      }
      await Promise.allSettled(pending);
      if (cleanupError) throw cleanupError;
    }
  }, 15_000);

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
    for (const name of [
      '0001_control_store.sql',
      '0002_registration_control.sql',
      '0003_isolated_runner.sql',
      '0004_agentops_lifecycle.sql',
      '0005_private_monitor_broker.sql',
      '0006_monitor_broker_capability_functions.sql',
      '0007_multi_repository_triage.sql',
    ]) {
      const valid = fs.readFileSync(
        path.join(process.cwd(), 'db', 'control-store', 'migrations', name),
        'utf8',
      );
      fs.writeFileSync(
        path.join(directory, name),
        name.startsWith('0007_')
          ? `${valid}\nTHIS IS DELIBERATELY INVALID SQL;\n`
          : valid,
      );
    }
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

  it('deduplicates typed monitor work, fences stale leases, and rejects stale Registration', async () => {
    const store = await migratedStore();
    const repo = await store.createRegistration({
      repository: 'mrbaron3/workflow',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const requestId = await insertMonitorBrokerRequest({
      registrationId: repo.id,
      registrationVersion: repo.version,
      repository: repo.repository,
    });
    await expect(insertMonitorBrokerRequest({
      registrationId: repo.id,
      registrationVersion: repo.version,
    })).rejects.toMatchObject({ code: '23505' });

    const claims = await Promise.all([
      store.claimMonitorBrokerRequest({
        workerId: 'monitor-runner-a',
        allowedRepositories: [repo.repository],
        leaseMs: 5_000,
      }),
      store.claimMonitorBrokerRequest({
        workerId: 'monitor-runner-b',
        allowedRepositories: [repo.repository],
        leaseMs: 5_000,
      }),
    ]);
    const first = claims.find((claim) => claim !== null);
    expect(first).toMatchObject({
      id: requestId,
      registrationId: repo.id,
      registrationVersion: repo.version,
      repository: repo.repository,
      monitorKind: 'issue',
      cursor: { updatedAfter: '' },
    });
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

    await pool.query(
      `UPDATE agentops_control.monitor_broker_requests
          SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [requestId],
    );
    await expect(store.failMonitorBrokerRequest({
      request: first!,
      workerId: claims[0] === first ? 'monitor-runner-a' : 'monitor-runner-b',
      code: 'late_provider_failure',
      message: 'must not overwrite an expired lease',
    })).rejects.toThrow(/stale or lost/);
    const stillLeased = await pool.query<{ status: string }>(
      `SELECT status
         FROM agentops_control.monitor_broker_requests
        WHERE id = $1`,
      [requestId],
    );
    expect(stillLeased.rows[0]?.status).toBe('leased');
    const recovered = await store.claimMonitorBrokerRequest({
      workerId: 'monitor-runner-recovery',
      allowedRepositories: [repo.repository],
      leaseMs: 5_000,
    });
    expect(recovered).toMatchObject({ id: requestId });
    expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
    const response = {
      items: [],
      nextCursor: { updatedAfter: '' },
      observedAt: new Date().toISOString(),
    };
    await expect(store.completeMonitorBrokerRequest({
      request: first!,
      workerId: claims[0] === first ? 'monitor-runner-a' : 'monitor-runner-b',
      response,
    })).rejects.toThrow(/stale or lost/);
    await store.completeMonitorBrokerRequest({
      request: recovered!,
      workerId: 'monitor-runner-recovery',
      response,
    });

    const staleId = await insertMonitorBrokerRequest({
      registrationId: repo.id,
      registrationVersion: repo.version,
      kind: 'pull_request',
    });
    await store.updateRegistration(repo.id, { enabled: false });
    await expect(store.claimMonitorBrokerRequest({
      workerId: 'monitor-runner-stale',
      allowedRepositories: [repo.repository],
      leaseMs: 5_000,
    })).resolves.toBeNull();
    const stale = await pool.query<{
      status: string;
      error_code: string | null;
    }>(
      `SELECT status, error_code
         FROM agentops_control.monitor_broker_requests
        WHERE id = $1`,
      [staleId],
    );
    expect(stale.rows[0]).toMatchObject({
      status: 'failed',
      error_code: 'stale_registration',
    });
    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type
         FROM agentops_control.runtime_audit
        WHERE registration_id = $1
          AND event_type LIKE 'monitor.broker.%'
        ORDER BY id`,
      [repo.id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'monitor.broker.claimed',
      'monitor.broker.completed',
      'monitor.broker.denied',
    ]));
  });

  it('grants broker capabilities only to the triage role', async () => {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage'
        ) THEN
          CREATE ROLE agentops_triage NOLOGIN;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner'
        ) THEN
          CREATE ROLE agentops_runner NOLOGIN;
        END IF;
      END $$
    `);
    const store = await migratedStore();
    await pool.query(
      `GRANT USAGE ON SCHEMA agentops_control TO agentops_triage, agentops_runner`,
    );
    await pool.query(
      `GRANT SELECT ON agentops_control.monitor_broker_requests
         TO agentops_triage`,
    );
    const repo = await store.createRegistration({
      repository: 'acme/widgets',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const requestId = await insertMonitorBrokerRequest({
      registrationId: repo.id,
      registrationVersion: repo.version,
      repository: repo.repository,
    });
    const request = await store.claimMonitorBrokerRequest({
      workerId: 'capability-triage',
      allowedRepositories: [repo.repository],
      leaseMs: 30_000,
    });
    expect(request).toMatchObject({ id: requestId });
    const validResponse = {
      items: [],
      nextCursor: { updatedAfter: '' },
      observedAt: new Date().toISOString(),
    };

    const triage = await pool.connect();
    try {
      await triage.query('SET ROLE agentops_triage');
      await expect(triage.query(
        `UPDATE agentops_control.monitor_broker_requests
            SET status = 'succeeded', response = '{}'::jsonb,
                completed_at = clock_timestamp()
          WHERE id = $1`,
        [requestId],
      )).rejects.toMatchObject({ code: '42501' });

      const wrongLease = await triage.query<{ registration_id: string | null }>(
        `SELECT agentops_control.complete_monitor_broker_request(
           $1, $2, $3, $4
         ) AS registration_id`,
        [requestId, randomUUID(), 'capability-triage', validResponse],
      );
      expect(wrongLease.rows[0]?.registration_id).toBeNull();

      await expect(triage.query(
        `SELECT agentops_control.complete_monitor_broker_request(
           $1, $2, $3, $4
         )`,
        [
          requestId,
          request!.leaseToken,
          'capability-triage',
          {
            items: [{
              repository: 'attacker/forged',
              kind: 'issue',
              number: 1,
              updatedAt: new Date().toISOString(),
            }],
            nextCursor: { updatedAfter: '' },
            observedAt: new Date().toISOString(),
          },
        ],
      )).rejects.toThrow(/invalid monitor broker response/);
    } finally {
      await triage.query('RESET ROLE');
      triage.release();
    }

    const runner = await pool.connect();
    try {
      await runner.query('SET ROLE agentops_runner');
      await expect(runner.query(
        `SELECT agentops_control.complete_monitor_broker_request(
           $1, $2, $3, $4
         )`,
        [requestId, request!.leaseToken, 'capability-runner', validResponse],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runner.query('RESET ROLE');
      runner.release();
    }

    const durable = await pool.query<{
      status: string;
      response: Record<string, unknown> | null;
    }>(
      `SELECT status, response
         FROM agentops_control.monitor_broker_requests
        WHERE id = $1`,
      [requestId],
    );
    expect(durable.rows[0]).toEqual({ status: 'leased', response: null });
    await store.completeMonitorBrokerRequest({
      request: request!,
      workerId: 'capability-triage',
      response: validResponse,
    });
  });

  it('enforces triage and development job-type isolation in PostgreSQL', async () => {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'agentops_triage'
        ) THEN
          CREATE ROLE agentops_triage NOLOGIN;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner'
        ) THEN
          CREATE ROLE agentops_runner NOLOGIN;
        END IF;
      END $$
    `);
    const store = await migratedStore();
    await pool.query(
      `GRANT USAGE ON SCHEMA agentops_control
         TO agentops_triage, agentops_runner`,
    );
    await pool.query(
      `GRANT SELECT, UPDATE ON agentops_control.jobs
         TO agentops_triage, agentops_runner`,
    );
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE ON agentops_control.job_attempts,
         agentops_control.job_leases
         TO agentops_triage, agentops_runner`,
    );
    const triageRepo = await store.createRegistration({
      repository: 'sample/triage-target',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const developmentRepo = await store.createRegistration({
      repository: 'sample/development-target',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const triageJob = await store.enqueueJob({
      registrationId: triageRepo.id,
      registrationVersion: triageRepo.version,
      source: { kind: 'poll', key: 'triage-role-scope' },
      idempotencyKey: 'triage-role-scope',
      jobType: 'agentops.triage',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'triage-target' },
        issue: {
          number: 8,
          observedUpdatedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    });
    const developmentJob = await store.enqueueJob({
      registrationId: developmentRepo.id,
      registrationVersion: developmentRepo.version,
      source: { kind: 'manual', key: 'development-role-scope' },
      idempotencyKey: 'development-role-scope',
      jobType: 'agentops.runner',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'development-target' },
        event: { kind: 'issue', number: 14, action: 'labeled' },
        target: { baseRef: 'refs/heads/main' },
        execution: {
          mode: 'development_turn',
          requiredChecks: ['test'],
          mergeMethod: 'squash',
          readyLabel: 'ready',
          claimedLabel: 'agent-claimed',
        },
        artifacts: [],
      },
    });

    for (const role of ['agentops_triage', 'agentops_runner'] as const) {
      const ownJob = role === 'agentops_triage'
        ? triageJob.job
        : developmentJob.job;
      const otherJob = role === 'agentops_triage'
        ? developmentJob.job
        : triageJob.job;
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        const visible = await client.query<{ id: string; job_type: string }>(
          `SELECT id, job_type
             FROM agentops_control.jobs
            ORDER BY id`,
        );
        expect(visible.rows).toEqual([{
          id: ownJob.id,
          job_type: ownJob.jobType,
        }]);
        const allowed = await client.query<{ id: string }>(
          `UPDATE agentops_control.jobs
              SET last_error = NULL
            WHERE id = $1
            RETURNING id`,
          [ownJob.id],
        );
        expect(allowed.rows).toEqual([{ id: ownJob.id }]);
        await expect(client.query(
          `INSERT INTO agentops_control.job_attempts(
             id, job_id, attempt_number, worker_id, status
           ) VALUES ($1, $2, 1, 'own-role-check', 'running')`,
          [randomUUID(), ownJob.id],
        )).resolves.toMatchObject({ rowCount: 1 });
        const forged = await client.query<{ id: string }>(
          `UPDATE agentops_control.jobs
              SET last_error = 'cross-role-forgery'
            WHERE id = $1
            RETURNING id`,
          [otherJob.id],
        );
        expect(forged.rows).toEqual([]);
        await expect(client.query(
          `INSERT INTO agentops_control.job_attempts(
             id, job_id, attempt_number, worker_id, status
           ) VALUES ($1, $2, 1, 'cross-role-forgery', 'running')`,
          [randomUUID(), otherJob.id],
        )).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    }
  });

  it('atomically promotes a triaged Issue with configured label semantics', async () => {
    const store = await migratedStore();
    const repo = await store.createRegistration({
      repository: 'sample/design-system',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const queued = await store.enqueueJob({
      registrationId: repo.id,
      registrationVersion: repo.version,
      source: { kind: 'poll', key: 'issue:27' },
      idempotencyKey: 'issue:27',
      jobType: 'agentops.triage',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'design-system' },
        issue: {
          number: 27,
          observedUpdatedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    });
    const lease = await store.acquireLease({
      workerId: 'triage-custom-labels',
      durationMs: 30_000,
      jobType: 'agentops.triage',
    });
    expect(lease?.job.id).toBe(queued.job.id);
    const promotedJobId = await store.promoteTriageLease({
      token: lease!.token,
      workerId: 'triage-custom-labels',
      readyLabel: 'human-approved',
      claimedLabel: 'automation-owned',
      result: {
        schemaVersion: 1,
        status: 'succeeded',
        jobId: lease!.job.id,
        attemptNumber: lease!.attemptNumber,
        repository: repo.repository,
        issueNumber: 27,
        outcome: 'promoted',
        sourceDigest: null,
        decision: null,
        commentUrl: null,
        appliedLabels: [],
        promotedJobId: null,
        completedAt: '2026-07-29T00:01:00.000Z',
      },
    });
    const jobs = await pool.query<{
      id: string;
      job_type: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, job_type, status, payload
         FROM agentops_control.jobs
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at, id`,
      [[queued.job.id, promotedJobId]],
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.find((job) => job.id === queued.job.id)).toMatchObject({
      job_type: 'agentops.triage',
      status: 'succeeded',
    });
    expect(jobs.rows.find((job) => job.id === promotedJobId)).toMatchObject({
      job_type: 'agentops.runner',
      status: 'queued',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'design-system' },
        event: { kind: 'issue', number: 27, action: 'recovery' },
        execution: {
          mode: 'development_turn',
          readyLabel: 'human-approved',
          claimedLabel: 'automation-owned',
        },
      },
    });
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

  it('requeues an observation rejected only by a Registration version change', async () => {
    const store = await migratedStore();
    const repo = await registration(store, '-requeue');
    const first = await enqueue(
      store,
      repo.id,
      repo.version,
      'versioned-observation',
      'webhook',
    );
    const updated = await store.updateRegistration(repo.id, { configuration: {} });
    const recovered = await enqueue(
      store,
      updated.id,
      updated.version,
      'versioned-observation',
      'poll',
    );
    expect(recovered.duplicate).toBe(false);
    expect(recovered.job).toMatchObject({
      id: first.job.id,
      registrationVersion: updated.version,
      status: 'queued',
    });
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*) FROM agentops_control.runtime_audit
        WHERE job_id = $1
          AND event_type = 'job.requeued_after_registration_change'`,
      [first.job.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    await expect(pool.query(
      `UPDATE agentops_control.repository_registrations
          SET configuration = '{"command":"unsafe"}'::jsonb
        WHERE id = $1`,
      [repo.id],
    )).rejects.toThrow();
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

  it('scopes isolated-runner claim and reclaim to agentops.runner jobs', async () => {
    const store = await migratedStore();
    const legacyRegistration = await registration(store, '-legacy');
    const runnerRegistration = await registration(store, '-runner');
    await enqueue(
      store,
      legacyRegistration.id,
      legacyRegistration.version,
      'legacy-first',
    );
    const runnerJob = await enqueueRunner(
      store,
      runnerRegistration.id,
      runnerRegistration.version,
      '-runner',
    );

    const runnerLease = await store.acquireLease({
      workerId: 'isolated-runner',
      durationMs: 10_000,
      jobType: 'agentops.runner',
    });
    expect(runnerLease?.job.id).toBe(runnerJob.job.id);
    await store.finishLease(runnerLease!.token, { status: 'succeeded' });

    const legacyLease = await store.acquireLease({
      workerId: 'legacy-consumer',
      durationMs: 20,
    });
    expect(legacyLease?.job.jobType).toBe('github_issue_turn');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await store.reclaimExpiredLeases(3, {
      jobType: 'agentops.runner',
      retryBaseMs: 1_000,
    })).toBe(0);
    const legacyState = await pool.query<{ status: string }>(
      `SELECT status FROM agentops_control.job_leases WHERE id = $1`,
      [legacyLease!.id],
    );
    expect(legacyState.rows[0]?.status).toBe('active');
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
    await expect(store.failOrRetryLease({
      token: first!.token,
      workerId: 'worker-a',
      failure: {
        schemaVersion: 1,
        status: 'failed',
        code: 'provider_failure',
        message: 'stale worker must not retry',
        retryable: true,
        boundary: 'provider',
        observedAt: new Date().toISOString(),
      },
      retryDelayMs: 0,
      maxAttempts: 2,
    })).rejects.toBeInstanceOf(LeaseRejectedError);
    expect(await store.reclaimExpiredLeases()).toBe(1);
    const second = await store.acquireLease({ workerId: 'worker-b', durationMs: 1_000 });
    expect(second?.job.id).toBe(first?.job.id);
    expect(second?.attemptNumber).toBe(2);
    const attempts = await pool.query<{
      status: string;
      failure: Record<string, unknown> | null;
    }>(
      `SELECT status, failure FROM agentops_control.job_attempts
        WHERE job_id = $1 ORDER BY attempt_number`,
      [first!.job.id],
    );
    expect(attempts.rows.map((row) => row.status)).toEqual(['timed_out', 'running']);
    expect(attempts.rows[0]?.failure).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      code: 'lease_lost',
      retryable: true,
      boundary: null,
    });
    const artifactId = await store.linkArtifact({
      jobId: second!.job.id,
      attemptId: second!.attemptId,
      kind: 'test-output',
      uri: `volume://registrations/${repo.id}/tests/attempt-2.log`,
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
      uri: `volume://registrations/${repo.id}/tests/attempt-2.log`,
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
    const stale = await pool.query<{
      status: string;
      failure: Record<string, unknown>;
    }>(
      'SELECT status, failure FROM agentops_control.jobs WHERE id = $1',
      [lease!.job.id],
    );
    expect(stale.rows[0]?.status).toBe('rejected');
    expect(stale.rows[0]?.failure).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      code: 'registration_stale',
      retryable: false,
      boundary: 'claim',
    });
    await expect(enqueue(
      store,
      repo.id,
      updated.version,
      'replacement-after-stale-lease',
    )).resolves.toMatchObject({ duplicate: false });
  });

  it('terminates crash/expiry retries at the configured attempt ceiling', async () => {
    const store = await migratedStore();
    const repo = await registration(store, '-expiry-ceiling');
    await enqueue(store, repo.id, repo.version, 'expiry-ceiling');
    const lease = await store.acquireLease({
      workerId: 'worker-expiry-ceiling',
      durationMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await store.reclaimExpiredLeases(1)).toBe(1);
    await expect(store.acquireLease({
      workerId: 'worker-after-ceiling',
      durationMs: 1_000,
    })).resolves.toBeNull();
    const outcome = await pool.query<{
      status: string;
      failure: Record<string, unknown>;
    }>(
      'SELECT status, failure FROM agentops_control.jobs WHERE id = $1',
      [lease!.job.id],
    );
    expect(outcome.rows[0]).toMatchObject({
      status: 'failed',
      failure: {
        schemaVersion: 1,
        code: 'lease_lost',
        retryable: false,
      },
    });
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

  it('audits fail-closed Registration races at claim/provider/push/merge/release', async () => {
    const store = await migratedStore();
    const boundaries = ['claim', 'provider', 'push', 'merge', 'release'] as const;
    for (const boundary of boundaries) {
      const suffix = `-${boundary}`;
      const repo = await registration(store, suffix);
      await enqueueRunner(store, repo.id, repo.version, suffix);
      if (boundary === 'claim') {
        await store.updateRegistration(repo.id, { executionEnabled: false });
        await expect(store.acquireLease({
          workerId: `runner-${boundary}`,
          durationMs: 5_000,
        })).resolves.toBeNull();
      } else {
        const lease = await store.acquireLease({
          workerId: `runner-${boundary}`,
          durationMs: 5_000,
        });
        expect(lease).not.toBeNull();
        await store.updateRegistration(repo.id, { executionEnabled: false });
        await expect(store.assertExecutionGuard({
          token: lease!.token,
          workerId: `runner-${boundary}`,
          boundary,
        })).resolves.toMatchObject({
          ok: false,
          reason: 'registration_execution_disabled',
          jobId: lease!.job.id,
        });
      }
      const audit = await pool.query<{
        event_type: string;
        reason: string;
      }>(
        `SELECT event_type, details->>'reason' AS reason
           FROM agentops_control.runtime_audit
          WHERE registration_id = $1
            AND event_type = $2`,
        [repo.id, `runner.boundary.${boundary}.denied`],
      );
      expect(audit.rows).toEqual([{
        event_type: `runner.boundary.${boundary}.denied`,
        reason: 'registration_execution_disabled',
      }]);
    }
  });

  it('revalidates a live lease at every allowed critical boundary', async () => {
    const store = await migratedStore();
    const repo = await registration(store, '-allowed-boundaries');
    await enqueueRunner(store, repo.id, repo.version, '-allowed-boundaries');
    const lease = await store.acquireLease({
      workerId: 'runner-allowed',
      durationMs: 10_000,
    });
    expect(lease).not.toBeNull();
    for (const boundary of ['provider', 'push', 'merge', 'release'] as const) {
      await expect(store.assertExecutionGuard({
        token: lease!.token,
        workerId: 'runner-allowed',
        boundary,
      })).resolves.toMatchObject({
        ok: true,
        reason: null,
        jobId: lease!.job.id,
        registration: {
          id: repo.id,
          version: repo.version,
          enabled: true,
          executionEnabled: true,
        },
      });
    }
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type
         FROM agentops_control.runtime_audit
        WHERE job_id = $1 AND event_type LIKE 'runner.boundary.%.allowed'
        ORDER BY event_type`,
      [lease!.job.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'runner.boundary.claim.allowed',
      'runner.boundary.merge.allowed',
      'runner.boundary.provider.allowed',
      'runner.boundary.push.allowed',
      'runner.boundary.release.allowed',
    ]);
  });

  it('records typed retry history and never retries stale Registration work', async () => {
    const store = await migratedStore();
    const repo = await registration(store, '-typed-retry');
    await enqueueRunner(store, repo.id, repo.version, '-typed-retry');
    const first = await store.acquireLease({
      workerId: 'runner-retry',
      durationMs: 10_000,
    });
    const failure = {
      schemaVersion: 1 as const,
      status: 'failed' as const,
      code: 'provider_failure' as const,
      message: 'provider temporarily unavailable',
      retryable: true,
      boundary: 'provider' as const,
      observedAt: new Date().toISOString(),
    };
    await expect(store.failOrRetryLease({
      token: first!.token,
      workerId: 'runner-retry',
      failure,
      retryDelayMs: 0,
      maxAttempts: 2,
    })).resolves.toBe('queued');
    const second = await store.acquireLease({
      workerId: 'runner-retry',
      durationMs: 10_000,
    });
    expect(second?.attemptNumber).toBe(2);
    await store.updateRegistration(repo.id, { executionEnabled: false });
    await expect(store.failOrRetryLease({
      token: second!.token,
      workerId: 'runner-retry',
      failure,
      retryDelayMs: 0,
      maxAttempts: 3,
    })).resolves.toBe('rejected');
    const persisted = await pool.query<{
      job_status: string;
      job_failure: Record<string, unknown>;
      attempt_status: string;
      attempt_failure: Record<string, unknown>;
    }>(
      `SELECT j.status AS job_status, j.failure AS job_failure,
              a.status AS attempt_status, a.failure AS attempt_failure
         FROM agentops_control.jobs j
         JOIN agentops_control.job_attempts a ON a.job_id = j.id
        WHERE j.id = $1
        ORDER BY a.attempt_number DESC
        LIMIT 1`,
      [first!.job.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      job_status: 'rejected',
      job_failure: failure,
      attempt_status: 'failed',
      attempt_failure: failure,
    });
  });

  it('runs a safe existing-AgentOps-shaped path through all fences and stores only artifact metadata', async () => {
    const store = await migratedStore();
    const repo = await registration(store, '-service');
    const queued = await enqueueRunner(store, repo.id, repo.version, '-service');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-runner-service-'));
    const commandRunner: WorkspaceCommandRunner = (_command, args) => {
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      if (args.includes('get-url')) {
        return {
          status: 0,
          stdout: 'https://github.com/mrbaron3/control-store-service.git\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const adapter: AgentOpsRunnerAdapter = {
      async execute(input) {
        await input.fence.arm('push');
        input.fence.consume('push');
        await input.fence.arm('merge');
        input.fence.consume('merge');
        await input.fence.arm('release');
        input.fence.consume('release');
        return {
          headSha: 'b'.repeat(40),
          pullRequestNumber: 38,
          developmentTurn: {
            intake: [],
            enrichmentIds: [],
            driveResults: [],
          },
        };
      },
    };
    const service = new IsolatedRunnerService({
      operatingMode: 'ACTIVE',
      workerId: 'runner-service',
      workspaceRoot: root,
      provider: 'codex',
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
      reconciliationIntervalMs: 250,
      maxAttempts: 2,
      retryBaseMs: 0,
      attemptTimeoutMs: 60_000,
    }, {
      store,
      workspace: new RunnerWorkspaceManager(root, {}, commandRunner),
      adapter,
    });
    await expect(service.runOnce()).resolves.toBe(true);
    const outcome = await pool.query<{
      status: string;
      result: Record<string, unknown>;
      payload: Record<string, unknown>;
      artifact_count: string;
      artifact_uri: string;
    }>(
      `SELECT j.status, j.result, j.payload,
              count(a.id)::text AS artifact_count,
              min(a.uri) AS artifact_uri
         FROM agentops_control.jobs j
         LEFT JOIN agentops_control.artifact_links a ON a.job_id = j.id
        WHERE j.id = $1
        GROUP BY j.id`,
      [queued.job.id],
    );
    expect(outcome.rows[0]).toMatchObject({
      status: 'succeeded',
      result: {
        schemaVersion: 1,
        status: 'succeeded',
        jobId: queued.job.id,
        headSha: 'b'.repeat(40),
        pullRequestNumber: 38,
      },
      artifact_count: '1',
    });
    expect(outcome.rows[0]?.artifact_uri).toMatch(
      new RegExp(`^volume://registrations/${repo.id}/`),
    );
    expect(JSON.stringify(outcome.rows[0]?.payload)).not.toContain('runner-result');
    expect(await fs.promises.readFile(
      path.join(
        root,
        'registrations',
        repo.id,
        'jobs',
        queued.job.id,
        'attempt-1',
        'artifacts',
        'runner-result.json',
      ),
      'utf8',
    )).toContain('"developmentTurn"');
  });

  it('leaves durable final-suite evidence for every stale critical boundary', async () => {
    const store = await migratedStore();
    for (const boundary of ['claim', 'provider', 'push', 'merge', 'release'] as const) {
      const suffix = `-final-${boundary}`;
      const repo = await registration(store, suffix);
      await enqueueRunner(store, repo.id, repo.version, suffix);
      if (boundary === 'claim') {
        await store.updateRegistration(repo.id, { enabled: false });
      } else {
        const lease = await store.acquireLease({
          workerId: `runner-final-${boundary}`,
          durationMs: 60_000,
        });
        await store.updateRegistration(repo.id, { enabled: false });
        await store.assertExecutionGuard({
          token: lease!.token,
          workerId: `runner-final-${boundary}`,
          boundary,
        });
      }
    }
    const allowedRepo = await registration(store, '-final-allowed');
    await enqueueRunner(
      store,
      allowedRepo.id,
      allowedRepo.version,
      '-final-allowed',
    );
    const allowedLease = await store.acquireLease({
      workerId: 'runner-final-allowed',
      durationMs: 60_000,
    });
    for (const boundary of ['provider', 'push', 'merge', 'release'] as const) {
      await expect(store.assertExecutionGuard({
        token: allowedLease!.token,
        workerId: 'runner-final-allowed',
        boundary,
      })).resolves.toMatchObject({ ok: true, reason: null });
    }
    const durable = await pool.query<{ boundary: string; reason: string }>(
      `SELECT split_part(event_type, '.', 3) AS boundary,
              details->>'reason' AS reason
         FROM agentops_control.runtime_audit
        WHERE event_type LIKE 'runner.boundary.%.denied'
        ORDER BY boundary`,
    );
    expect(durable.rows).toEqual([
      { boundary: 'claim', reason: 'registration_disabled' },
      { boundary: 'merge', reason: 'registration_disabled' },
      { boundary: 'provider', reason: 'registration_disabled' },
      { boundary: 'push', reason: 'registration_disabled' },
      { boundary: 'release', reason: 'registration_disabled' },
    ]);
  });
});
