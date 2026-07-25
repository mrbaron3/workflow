import { randomUUID } from 'node:crypto';
import {
  Pool,
  type Notification,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import { assertControlSchema, migrateControlSchema } from './migrations.js';
import {
  EnqueueJobInput,
  LeaseRejectedError,
  RepositoryBusyError,
  RepositoryRegistrationInput,
  RepositoryRegistrationPatch,
  StaleRegistrationError,
  type EnqueueResult,
  type JobEnvelope,
  type Lease,
  type ReconciliationWork,
  type RepositoryRegistration,
} from './types.js';

interface RegistrationRow extends QueryResultRow {
  id: string;
  repository: string;
  enabled: boolean;
  issue_monitor_enabled: boolean;
  pr_monitor_enabled: boolean;
  execution_enabled: boolean;
  configuration: Record<string, unknown>;
  version: string;
  created_at: Date;
  updated_at: Date;
}

interface JobRow extends QueryResultRow {
  id: string;
  registration_id: string;
  registration_version: string;
  contract_version: number;
  source_kind: JobEnvelope['source']['kind'];
  source_key: string;
  idempotency_key: string;
  job_type: string;
  payload: Record<string, unknown>;
  status: JobEnvelope['status'];
  created_at: Date;
}

function registration(row: RegistrationRow): RepositoryRegistration {
  return {
    id: row.id,
    repository: row.repository,
    enabled: row.enabled,
    issueMonitorEnabled: row.issue_monitor_enabled,
    prMonitorEnabled: row.pr_monitor_enabled,
    executionEnabled: row.execution_enabled,
    configuration: row.configuration,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function job(row: JobRow): JobEnvelope {
  return {
    contractVersion: 1,
    id: row.id,
    registrationId: row.registration_id,
    registrationVersion: Number(row.registration_version),
    source: { kind: row.source_kind, key: row.source_key },
    idempotencyKey: row.idempotency_key,
    jobType: row.job_type,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

async function transaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the transaction's original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface OpenControlStoreOptions {
  migrate?: boolean;
  migrationRoot?: string;
}

/**
 * Transactional TypeScript adapter for the language-neutral SQL contract.
 * No method falls back to JSON or in-memory durable state.
 */
export class PostgresControlStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
  }

  static async open(
    config: PoolConfig,
    options: OpenControlStoreOptions = {},
  ): Promise<PostgresControlStore> {
    const store = new PostgresControlStore(config);
    try {
      if (options.migrate) {
        await migrateControlSchema(store.pool, { root: options.migrationRoot });
      } else {
        await assertControlSchema(store.pool, { root: options.migrationRoot });
      }
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createRegistration(input: unknown): Promise<RepositoryRegistration> {
    const parsed = RepositoryRegistrationInput.parse(input);
    const result = await this.pool.query<RegistrationRow>(
      `INSERT INTO agentops_control.repository_registrations(
         id, repository, enabled, issue_monitor_enabled, pr_monitor_enabled,
         execution_enabled, configuration
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        randomUUID(),
        parsed.repository,
        parsed.enabled,
        parsed.issueMonitorEnabled,
        parsed.prMonitorEnabled,
        parsed.executionEnabled,
        parsed.configuration,
      ],
    );
    return registration(result.rows[0]!);
  }

  async updateRegistration(
    id: string,
    patch: Partial<Omit<RepositoryRegistrationInput, 'repository'>>,
  ): Promise<RepositoryRegistration> {
    const parsedPatch = RepositoryRegistrationPatch.parse(patch);
    const allowed = [
      ['enabled', 'enabled'],
      ['issueMonitorEnabled', 'issue_monitor_enabled'],
      ['prMonitorEnabled', 'pr_monitor_enabled'],
      ['executionEnabled', 'execution_enabled'],
      ['configuration', 'configuration'],
    ] as const;
    const changes = allowed.filter(([property]) => parsedPatch[property] !== undefined);
    const values = changes.map(([property]) => parsedPatch[property]);
    const assignments = changes.map(([, column], index) => `${column} = $${index + 2}`);
    const result = await this.pool.query<RegistrationRow>(
      `UPDATE agentops_control.repository_registrations
          SET ${assignments.join(', ')}, version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING *`,
      [id, ...values],
    );
    if (!result.rows[0]) throw new Error(`no such repository registration: ${id}`);
    return registration(result.rows[0]);
  }

  async getRegistration(id: string): Promise<RepositoryRegistration | null> {
    const result = await this.pool.query<RegistrationRow>(
      'SELECT * FROM agentops_control.repository_registrations WHERE id = $1',
      [id],
    );
    return result.rows[0] ? registration(result.rows[0]) : null;
  }

  async listRegistrations(): Promise<RepositoryRegistration[]> {
    const result = await this.pool.query<RegistrationRow>(
      'SELECT * FROM agentops_control.repository_registrations ORDER BY repository',
    );
    return result.rows.map(registration);
  }

  async saveMonitorCursor(input: {
    registrationId: string;
    monitorKind: 'issue' | 'pull_request';
    cursor: Record<string, unknown>;
    observedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agentops_control.monitor_cursors(
         registration_id, monitor_kind, cursor, observed_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (registration_id, monitor_kind) DO UPDATE
         SET cursor = EXCLUDED.cursor,
             observed_at = EXCLUDED.observed_at,
             updated_at = clock_timestamp()`,
      [input.registrationId, input.monitorKind, input.cursor, input.observedAt],
    );
  }

  async getMonitorCursor(
    registrationId: string,
    monitorKind: 'issue' | 'pull_request',
  ): Promise<{
    cursor: Record<string, unknown>;
    observedAt: string;
    updatedAt: string;
  } | null> {
    const result = await this.pool.query<{
      cursor: Record<string, unknown>;
      observed_at: Date;
      updated_at: Date;
    }>(
      `SELECT cursor, observed_at, updated_at
         FROM agentops_control.monitor_cursors
        WHERE registration_id = $1 AND monitor_kind = $2`,
      [registrationId, monitorKind],
    );
    const row = result.rows[0];
    return row ? {
      cursor: row.cursor,
      observedAt: row.observed_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    } : null;
  }

  async receiveWebhook(input: {
    deliveryKey: string;
    repository: string;
    event: string;
    action?: string | null;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }): Promise<{ deliveryId: string; duplicate: boolean; status: string }> {
    if (!input.deliveryKey.trim()) throw new Error('delivery key is required');
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const inserted = await client.query<{ id: string; status: string }>(
        `INSERT INTO agentops_control.webhook_deliveries(
           id, delivery_key, repository, event, action, headers, payload
         ) VALUES ($1, $2, lower($3), $4, $5, $6, $7)
         ON CONFLICT (delivery_key) DO NOTHING
         RETURNING id, status`,
        [
          id,
          input.deliveryKey,
          input.repository,
          input.event,
          input.action ?? null,
          input.headers,
          input.payload,
        ],
      );
      if (inserted.rows[0]) {
        return {
          deliveryId: inserted.rows[0].id,
          duplicate: false,
          status: inserted.rows[0].status,
        };
      }
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM agentops_control.webhook_deliveries
          WHERE delivery_key = $1`,
        [input.deliveryKey],
      );
      return {
        deliveryId: existing.rows[0]!.id,
        duplicate: true,
        status: existing.rows[0]!.status,
      };
    });
  }

  async setWebhookConsumers(
    deliveryId: string,
    registrationId: string,
    consumers: readonly string[],
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM agentops_control.webhook_deliveries
          WHERE id = $1 FOR UPDATE`,
        [deliveryId],
      );
      if (!locked.rows[0]) throw new Error(`no such webhook delivery: ${deliveryId}`);
      if (locked.rows[0].status !== 'pending') {
        throw new Error(`delivery ${deliveryId} is not pending`);
      }
      await client.query(
        `UPDATE agentops_control.webhook_deliveries
            SET registration_id = $2, status = 'processing',
                route_attempts = route_attempts + 1, updated_at = clock_timestamp()
          WHERE id = $1`,
        [deliveryId, registrationId],
      );
      for (const consumer of [...new Set(consumers)].sort()) {
        await client.query(
          `INSERT INTO agentops_control.webhook_consumers(delivery_id, consumer)
           VALUES ($1, $2)
           ON CONFLICT (delivery_id, consumer) DO NOTHING`,
          [deliveryId, consumer],
        );
      }
    });
  }

  async completeWebhookConsumer(
    deliveryId: string,
    consumer: string,
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agentops_control.webhook_consumers
          SET status = $3, attempts = attempts + 1, last_error = $4,
              completed_at = CASE WHEN $3 = 'completed' THEN clock_timestamp() END,
              updated_at = clock_timestamp()
        WHERE delivery_id = $1 AND consumer = $2`,
      [deliveryId, consumer, error ? 'failed' : 'completed', error ?? null],
    );
  }

  async finishWebhookDelivery(
    deliveryId: string,
    outcome:
      | { status: 'processed' }
      | { status: 'ignored'; reason: string }
      | { status: 'failed'; error: string },
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const delivery = await client.query<{
        status: string;
        registration_id: string | null;
      }>(
        `SELECT status, registration_id
           FROM agentops_control.webhook_deliveries
          WHERE id = $1 FOR UPDATE`,
        [deliveryId],
      );
      const row = delivery.rows[0];
      if (!row) throw new Error(`no such webhook delivery: ${deliveryId}`);
      if (outcome.status === 'processed') {
        if (row.status !== 'processing') {
          throw new Error(`delivery ${deliveryId} is not processing`);
        }
        const incomplete = await client.query<{ count: string }>(
          `SELECT count(*) AS count
             FROM agentops_control.webhook_consumers
            WHERE delivery_id = $1 AND status <> 'completed'`,
          [deliveryId],
        );
        if (Number(incomplete.rows[0]!.count) > 0) {
          throw new Error(`delivery ${deliveryId} has incomplete consumers`);
        }
      } else if (outcome.status === 'ignored' && row.registration_id !== null) {
        throw new Error(`routed delivery ${deliveryId} cannot be ignored`);
      }
      await client.query(
        `UPDATE agentops_control.webhook_deliveries
            SET status = $2,
                ignored_reason = $3,
                last_error = $4,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [
          deliveryId,
          outcome.status,
          outcome.status === 'ignored' ? outcome.reason : null,
          outcome.status === 'failed' ? outcome.error : null,
        ],
      );
    });
  }

  /** Crash recovery resets only unfinished delivery/consumer state. */
  async recoverInterruptedWebhooks(): Promise<number> {
    return transaction(this.pool, async (client) => {
      const interrupted = await client.query<{ id: string }>(
        `SELECT id
           FROM agentops_control.webhook_deliveries
          WHERE status = 'processing'
          ORDER BY received_at
          FOR UPDATE SKIP LOCKED`,
      );
      if (interrupted.rows.length === 0) return 0;
      const ids = interrupted.rows.map((row) => row.id);
      await client.query(
        `UPDATE agentops_control.webhook_consumers
            SET status = 'pending', last_error = NULL,
                updated_at = clock_timestamp()
          WHERE delivery_id = ANY($1::uuid[]) AND status IN ('processing', 'failed')`,
        [ids],
      );
      await client.query(
        `UPDATE agentops_control.webhook_deliveries
            SET status = 'pending', last_error = NULL,
                updated_at = clock_timestamp()
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return interrupted.rows.length;
    });
  }

  async enqueueJob(input: unknown): Promise<EnqueueResult> {
    const parsed = EnqueueJobInput.parse(input);
    return transaction(this.pool, async (client) => {
      const registrationResult = await client.query<RegistrationRow>(
        `SELECT * FROM agentops_control.repository_registrations
          WHERE id = $1 FOR SHARE`,
        [parsed.registrationId],
      );
      const current = registrationResult.rows[0];
      if (
        !current
        || !current.enabled
        || !current.execution_enabled
        || Number(current.version) !== parsed.registrationVersion
      ) {
        throw new StaleRegistrationError(
          `registration ${parsed.registrationId} is absent, disabled, or stale`,
        );
      }
      const duplicate = await client.query<JobRow>(
        'SELECT * FROM agentops_control.jobs WHERE idempotency_key = $1',
        [parsed.idempotencyKey],
      );
      if (duplicate.rows[0]) return { job: job(duplicate.rows[0]), duplicate: true };

      // Runtime rejection gives a useful error; the partial unique index remains
      // authoritative when parallel transactions race after this read.
      const active = await client.query<{ id: string }>(
        `SELECT id FROM agentops_control.jobs
          WHERE registration_id = $1 AND status IN ('queued', 'leased')
          LIMIT 1`,
        [parsed.registrationId],
      );
      if (active.rows[0]) {
        throw new RepositoryBusyError(
          `repository ${current.repository} already has active job ${active.rows[0].id}`,
        );
      }
      try {
        const result = await client.query<JobRow & { duplicate: boolean }>(
          `INSERT INTO agentops_control.jobs(
             id, registration_id, registration_version, source_kind, source_key,
             idempotency_key, job_type, payload, available_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, clock_timestamp()))
           ON CONFLICT (idempotency_key) DO UPDATE
             SET idempotency_key = EXCLUDED.idempotency_key
           RETURNING *, (xmax <> 0) AS duplicate`,
          [
            randomUUID(),
            parsed.registrationId,
            parsed.registrationVersion,
            parsed.source.kind,
            parsed.source.key,
            parsed.idempotencyKey,
            parsed.jobType,
            parsed.payload,
            parsed.availableAt ?? null,
          ],
        );
        return { job: job(result.rows[0]!), duplicate: result.rows[0]!.duplicate };
      } catch (error) {
        if (
          error
          && typeof error === 'object'
          && 'code' in error
          && error.code === '23505'
        ) {
          throw new RepositoryBusyError(
            `repository ${current.repository} already has an active job`,
          );
        }
        throw error;
      }
    });
  }

  async acquireLease(input: {
    workerId: string;
    durationMs: number;
  }): Promise<Lease | null> {
    if (!input.workerId.trim()) throw new Error('workerId is required');
    if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
      throw new Error('durationMs must be a positive integer');
    }
    return transaction(this.pool, async (client) => {
      const candidate = await client.query<JobRow>(
        `SELECT j.*
           FROM agentops_control.jobs j
           JOIN agentops_control.repository_registrations r ON r.id = j.registration_id
          WHERE j.status = 'queued'
            AND j.available_at <= clock_timestamp()
            AND r.enabled
            AND r.execution_enabled
            AND r.version = j.registration_version
          ORDER BY j.available_at, j.created_at
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1`,
      );
      const selected = candidate.rows[0];
      if (!selected) return null;
      const attemptNumber = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
           FROM agentops_control.job_attempts WHERE job_id = $1`,
        [selected.id],
      );
      const attemptId = randomUUID();
      const leaseId = randomUUID();
      const leaseToken = randomUUID();
      await client.query(
        `UPDATE agentops_control.jobs
            SET status = 'leased', updated_at = clock_timestamp()
          WHERE id = $1`,
        [selected.id],
      );
      await client.query(
        `INSERT INTO agentops_control.job_attempts(
           id, job_id, attempt_number, worker_id, status
         ) VALUES ($1, $2, $3, $4, 'running')`,
        [attemptId, selected.id, attemptNumber.rows[0]!.next, input.workerId],
      );
      const leaseResult = await client.query<{ expires_at: Date }>(
        `INSERT INTO agentops_control.job_leases(
           id, job_id, attempt_id, lease_token, worker_id, expires_at
         ) VALUES ($1, $2, $3, $4, $5, clock_timestamp() + ($6 * interval '1 millisecond'))
         RETURNING expires_at`,
        [leaseId, selected.id, attemptId, leaseToken, input.workerId, input.durationMs],
      );
      return {
        id: leaseId,
        token: leaseToken,
        workerId: input.workerId,
        attemptId,
        attemptNumber: attemptNumber.rows[0]!.next,
        expiresAt: leaseResult.rows[0]!.expires_at.toISOString(),
        job: { ...job(selected), status: 'leased' },
      };
    });
  }

  async heartbeatLease(token: string, durationMs: number): Promise<string> {
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new Error('durationMs must be a positive integer');
    }
    const result = await this.pool.query<{ expires_at: Date }>(
      `UPDATE agentops_control.job_leases
          SET heartbeat_at = clock_timestamp(),
              expires_at = clock_timestamp() + ($2 * interval '1 millisecond')
        WHERE lease_token = $1 AND status = 'active' AND expires_at > clock_timestamp()
        RETURNING expires_at`,
      [token, durationMs],
    );
    if (!result.rows[0]) throw new LeaseRejectedError('lease is absent, inactive, or expired');
    return result.rows[0].expires_at.toISOString();
  }

  async reclaimExpiredLeases(): Promise<number> {
    return transaction(this.pool, async (client) => {
      const expired = await client.query<{ id: string; job_id: string; attempt_id: string }>(
        `SELECT id, job_id, attempt_id
           FROM agentops_control.job_leases
          WHERE status = 'active' AND expires_at <= clock_timestamp()
          ORDER BY expires_at
          FOR UPDATE SKIP LOCKED`,
      );
      for (const lease of expired.rows) {
        await client.query(
          `UPDATE agentops_control.job_leases
              SET status = 'expired', released_at = clock_timestamp()
            WHERE id = $1`,
          [lease.id],
        );
        await client.query(
          `UPDATE agentops_control.job_attempts
              SET status = 'timed_out', finished_at = clock_timestamp(),
                  error = 'lease expired'
            WHERE id = $1 AND status = 'running'`,
          [lease.attempt_id],
        );
        await client.query(
          `UPDATE agentops_control.jobs
              SET status = 'queued', available_at = clock_timestamp(),
                  updated_at = clock_timestamp(), last_error = 'lease expired'
            WHERE id = $1 AND status = 'leased'`,
          [lease.job_id],
        );
      }
      return expired.rowCount ?? 0;
    });
  }

  async finishLease(
    token: string,
    outcome: { status: 'succeeded' | 'failed'; error?: string },
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const lease = await client.query<{ id: string; job_id: string; attempt_id: string }>(
        `SELECT id, job_id, attempt_id
           FROM agentops_control.job_leases
          WHERE lease_token = $1 AND status = 'active'
            AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [token],
      );
      const row = lease.rows[0];
      if (!row) throw new LeaseRejectedError('lease is absent, inactive, or expired');
      await client.query(
        `UPDATE agentops_control.job_leases
            SET status = 'completed', released_at = clock_timestamp()
          WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `UPDATE agentops_control.job_attempts
            SET status = $2, finished_at = clock_timestamp(), error = $3
          WHERE id = $1`,
        [row.attempt_id, outcome.status, outcome.error ?? null],
      );
      await client.query(
        `UPDATE agentops_control.jobs
            SET status = $2, finished_at = clock_timestamp(),
                updated_at = clock_timestamp(), last_error = $3
          WHERE id = $1`,
        [row.job_id, outcome.status, outcome.error ?? null],
      );
    });
  }

  async listReconciliationWork(): Promise<ReconciliationWork[]> {
    const result = await this.pool.query<{
      job_id: string;
      registration_id: string;
      repository: string;
      status: 'queued' | 'leased';
      available_at: Date;
      lease_expires_at: Date | null;
    }>(
      `SELECT j.id AS job_id, j.registration_id, r.repository, j.status,
              j.available_at, l.expires_at AS lease_expires_at
         FROM agentops_control.jobs j
         JOIN agentops_control.repository_registrations r ON r.id = j.registration_id
         LEFT JOIN agentops_control.job_leases l
           ON l.job_id = j.id AND l.status = 'active'
        WHERE j.status = 'queued'
           OR (j.status = 'leased' AND l.expires_at <= clock_timestamp())
        ORDER BY j.available_at, j.created_at`,
    );
    return result.rows.map((row) => ({
      jobId: row.job_id,
      registrationId: row.registration_id,
      repository: row.repository,
      status: row.status,
      availableAt: row.available_at.toISOString(),
      leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    }));
  }

  async appendAudit(input: {
    actorType: string;
    actorId: string;
    eventType: string;
    registrationId?: string;
    jobId?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agentops_control.runtime_audit(
         actor_type, actor_id, event_type, registration_id, job_id, details
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.actorType,
        input.actorId,
        input.eventType,
        input.registrationId ?? null,
        input.jobId ?? null,
        input.details ?? {},
      ],
    );
  }

  async linkArtifact(input: {
    jobId?: string;
    attemptId?: string;
    kind: string;
    uri: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agentops_control.artifact_links(
         id, job_id, attempt_id, kind, uri, sha256, size_bytes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.jobId ?? null,
        input.attemptId ?? null,
        input.kind,
        input.uri,
        input.sha256,
        input.sizeBytes,
      ],
    );
    return id;
  }

  async recordReleasedBuild(input: {
    registrationId: string;
    issueNumber?: number;
    pullRequestNumber?: number;
    revisionId: string;
    headSha: string;
    panelApproved: boolean;
    gateReturned?: boolean;
    releasedAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agentops_control.released_builds(
         id, registration_id, issue_number, pull_request_number, revision_id,
         head_sha, panel_approved, gate_returned, released_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.registrationId,
        input.issueNumber ?? null,
        input.pullRequestNumber ?? null,
        input.revisionId,
        input.headSha,
        input.panelApproved,
        input.gateReturned ?? false,
        input.releasedAt,
      ],
    );
    return id;
  }

  async recordBuildDefect(input: {
    buildId: string;
    defectKey: string;
    observationStage: 'review_oracle' | 'release_escape';
    severity: 'low' | 'medium' | 'high' | 'critical';
    issueUrl?: string;
    summary: string;
    discoveredAt: Date;
    details?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agentops_control.build_defects(
         id, build_id, defect_key, observation_stage, severity, issue_url,
         summary, discovered_at, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.buildId,
        input.defectKey,
        input.observationStage,
        input.severity,
        input.issueUrl ?? null,
        input.summary,
        input.discoveredAt,
        input.details ?? {},
      ],
    );
    return id;
  }

  async listFalsePassBuilds(): Promise<Array<{
    buildId: string;
    gateReturned: boolean;
    escapeCount: number;
  }>> {
    const result = await this.pool.query<{
      build_id: string;
      gate_returned: boolean;
      escape_count: string;
    }>(
      `SELECT b.id AS build_id, b.gate_returned,
              COUNT(d.id) FILTER (WHERE d.observation_stage = 'release_escape') AS escape_count
         FROM agentops_control.released_builds b
         LEFT JOIN agentops_control.build_defects d ON d.build_id = b.id
        WHERE b.panel_approved
        GROUP BY b.id, b.gate_returned
       HAVING b.gate_returned
           OR COUNT(d.id) FILTER (WHERE d.observation_stage = 'release_escape') > 0
        ORDER BY b.id`,
    );
    return result.rows.map((row) => ({
      buildId: row.build_id,
      gateReturned: row.gate_returned,
      escapeCount: Number(row.escape_count),
    }));
  }

  /** LISTEN is only a low-latency hint; callers must also reconcile periodically. */
  async listen(
    channel: 'agentops_job_wake' | 'agentops_registration_wake',
    onNotification: (notification: Notification) => void,
  ): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const listener = (notification: Notification): void => {
      if (notification.channel === channel) onNotification(notification);
    };
    client.on('notification', listener);
    try {
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      client.off('notification', listener);
      client.release();
      throw error;
    }
    return async () => {
      client.off('notification', listener);
      try {
        await client.query(`UNLISTEN ${channel}`);
      } finally {
        client.release();
      }
    };
  }
}
