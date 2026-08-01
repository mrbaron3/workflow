import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_SCHEMA_VERSION,
  PostgresControlStore,
  ReleaseCertificationError,
  ReleaseReceiptConflictError,
  migrateControlSchema,
} from '../src/control-store/index.js';
import type { DurableReleaseReceipt } from '../src/evidence/release-receipt.js';

vi.setConfig({ testTimeout: 20_000 });

const databaseUrl = process.env.AGENTOPS_TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration('PostgreSQL release receipt outbox', () => {
  let pool: Pool;
  let store: PostgresControlStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await pool.query('DROP SCHEMA IF EXISTS agentops_control CASCADE');
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
    expect(await migrateControlSchema(pool)).toBe(CONTROL_SCHEMA_VERSION);
    await pool.query(
      'GRANT USAGE ON SCHEMA agentops_control TO agentops_triage, agentops_runner',
    );
    await pool.query(
      `UPDATE agentops_control.lifecycle_state
          SET mode = 'ACTIVE', generation = generation + 1,
              updated_at = clock_timestamp()
        WHERE singleton`,
    );
    store = new PostgresControlStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('crosses split jobs and converges an already completed merge idempotently', async () => {
    const registration = await store.createRegistration({
      repository: 'sample/release-target',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const policy = {
      authority: 'human-ready-allowed' as const,
      requiredGateSignals: [
        { source: 'repository-grader' as const, name: 'contracts' },
        { source: 'github-check' as const, name: 'contracts' },
      ],
      requiredReviewPerspectives: ['security', 'correctness'],
      minimumHeadEpochs: 1,
    };
    const created = await store.createRelease({
      registrationId: registration.id,
      registrationVersion: registration.version,
      releaseKey: 'issue:7:release:1',
      repository: registration.repository,
      issueNumber: 7,
      policy,
    });
    const duplicate = await store.createRelease({
      registrationId: registration.id,
      registrationVersion: registration.version,
      releaseKey: 'issue:7:release:1',
      repository: registration.repository,
      issueNumber: 7,
      policy,
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      release: { id: created.release.id },
    });

    const jobIds: string[] = [];
    for (const key of ['generator-job', 'reconciliation-job']) {
      const job = await store.enqueueJob({
        registrationId: registration.id,
        registrationVersion: registration.version,
        source: { kind: 'manual', key },
        idempotencyKey: key,
        jobType: 'release-receipt-test',
        payload: { key },
      });
      await store.linkJobToRelease({
        jobId: job.job.id,
        releaseId: created.release.id,
      });
      const lease = await store.acquireLease({
        workerId: key,
        durationMs: 10_000,
      });
      expect(lease?.job).toMatchObject({
        id: job.job.id,
        releaseId: created.release.id,
      });
      await store.finishLease(lease!.token, { status: 'succeeded' });
      jobIds.push(job.job.id);
    }

    const releaseId = created.release.id;
    const repository = registration.repository;
    const at = (seconds: number) => new Date(
      Date.parse(created.release.createdAt) + seconds * 1_000,
    ).toISOString();
    const head = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    const authorityId = randomUUID();
    const buildId = randomUUID();
    const repositoryGradeId = randomUUID();
    const githubGradeId = randomUUID();
    const securityReviewId = randomUUID();
    const correctnessReviewId = randomUUID();
    const runtimeId = randomUUID();
    const common = (
      receiptId: string,
      receiptKey: string,
      recordedAt: string,
      causes: string[],
      jobId: string,
    ) => ({
      receiptId,
      receiptKey,
      releaseId,
      repository,
      issueNumber: 7,
      producer: { jobId },
      causes,
      recordedAt,
    });
    const receipts: DurableReleaseReceipt[] = [
      {
        ...common(authorityId, 'authority:human-ready', at(1), [], jobIds[0]!),
        kind: 'authority',
        route: 'human-ready',
        actor: { type: 'human', login: 'maintainer' },
        readyLabel: 'ready',
        readyAt: at(1),
      },
      {
        ...common(buildId, 'build:final', at(2), [authorityId], jobIds[0]!),
        kind: 'build',
        head,
        parentHead: null,
        invocationId: 'generator-1',
        role: 'generator',
      },
      {
        ...common(repositoryGradeId, 'grade:repository:contracts', at(3), [buildId], jobIds[1]!),
        kind: 'grade',
        head,
        signal: { source: 'repository-grader', name: 'contracts' },
        status: 'passed',
        detailsDigest: digest,
      },
      {
        ...common(githubGradeId, 'grade:github:contracts', at(4), [buildId], jobIds[1]!),
        kind: 'grade',
        head,
        signal: { source: 'github-check', name: 'contracts' },
        status: 'passed',
        detailsDigest: digest,
      },
      {
        ...common(securityReviewId, 'review:1:security', at(5), [buildId], jobIds[1]!),
        kind: 'review',
        head,
        headEpoch: 1,
        perspective: 'security',
        invocationId: 'review-security',
        verdict: 'approved',
        findings: [],
      },
      {
        ...common(correctnessReviewId, 'review:1:correctness', at(6), [buildId], jobIds[1]!),
        kind: 'review',
        head,
        headEpoch: 1,
        perspective: 'correctness',
        invocationId: 'review-correctness',
        verdict: 'approved',
        findings: [],
      },
      {
        ...common(runtimeId, 'runtime:release', at(7), [authorityId], jobIds[1]!),
        kind: 'runtime-provenance',
        consumer: {
          repository: 'sample/workflow',
          revision: 'c'.repeat(40),
        },
        environment: {
          kind: 'container',
          reference: 'runner@fixture',
          digest,
        },
        invocations: [
          {
            invocationId: 'generator-1',
            role: 'generator',
            provider: 'codex',
            model: {
              kind: 'provider-default',
              reference: 'codex-cli@fixture:default',
              resolverDigest: digest,
            },
            head,
          },
          ...['security', 'correctness'].map((perspective) => ({
            invocationId: `review-${perspective}`,
            role: 'reviewer' as const,
            provider: 'claude',
            model: { kind: 'explicit' as const, name: 'claude-fixture' },
            head,
          })),
        ],
      },
    ];
    for (const receipt of receipts) await store.recordReleaseReceipt(receipt);
    await expect(store.recordReleaseReceipt(receipts[0])).resolves.toMatchObject({
      receipt: { receiptId: authorityId },
    });

    const intent = {
      ...common(randomUUID(), 'merge-intent:21', at(8), receipts.map((receipt) => receipt.receiptId), jobIds[1]!),
      kind: 'merge-intent' as const,
      pullRequest: 21,
      expectedHead: head,
      observedPrHead: head,
    };
    await expect(store.authorizeReleaseMerge({ releaseId, intent }))
      .resolves.toMatchObject({
        id: releaseId,
        status: 'merge-authorized',
        pullRequest: 21,
        finalHead: head,
      });

    const merge = {
      ...common(randomUUID(), 'merge:21', at(9), [intent.receiptId], jobIds[1]!),
      kind: 'merge' as const,
      pullRequest: 21,
      expectedHead: head,
      observedPrHead: head,
      mergeSha: 'd'.repeat(40),
      actor: 'workflow-app[bot]',
      issueState: 'CLOSED' as const,
      issueStateReason: 'COMPLETED' as const,
      mergeReachableFromDefaultBranch: true as const,
      mergedAt: at(9),
    };
    const completed = await store.completeReleaseMerge({ releaseId, receipt: merge });
    expect(completed).toMatchObject({
      status: 'merged',
      finalHead: head,
      mergeSha: 'd'.repeat(40),
    });
    await expect(store.completeReleaseMerge({
      releaseId,
      receipt: {
        ...merge,
        receiptId: randomUUID(),
        receiptKey: 'merge:21:recovery-observation',
        recordedAt: at(10),
      },
    }))
      .resolves.toEqual(completed);

    const receiptIds = (await store.listReleaseReceipts(releaseId, {
      includeMergeIntent: true,
    })).map((entry) => entry.receipt.receiptId);
    const artifact = {
      kind: 'runner-result',
      uri: `volume://registrations/${registration.id}/release/evidence.json`,
      sha256: 'e'.repeat(64),
      sizeBytes: 512,
      releaseId,
      sourceHead: head,
      receiptIds,
    };
    await expect(store.recordReleaseArtifact({
      artifactKey: 'runner-result:final',
      artifact,
    })).resolves.toEqual(artifact);
    await expect(store.recordReleaseArtifact({
      artifactKey: 'runner-result:final',
      artifact,
    })).resolves.toEqual(artifact);
    await expect(pool.query(
      `UPDATE agentops_control.release_artifacts
          SET uri = $2
        WHERE release_id = $1 AND artifact_key = 'runner-result:final'`,
      [releaseId, `${artifact.uri}.mutated`],
    )).rejects.toThrow(/immutable/);
    await expect(pool.query(
      `DELETE FROM agentops_control.release_receipt_outbox
        WHERE receipt_id = $1`,
      [authorityId],
    )).rejects.toThrow(/immutable/);
    await expect(store.exportReleaseEvidence(releaseId)).resolves.toMatchObject({
      schemaVersion: '2.0',
      release: { id: releaseId, finalHead: head, mergeSha: 'd'.repeat(40) },
      receipts: {
        mergeIntent: { receiptId: intent.receiptId },
        merge: { receiptId: merge.receiptId },
      },
      artifacts: [artifact],
      result: 'passed',
    });

    const cleanupJob = await store.enqueueJob({
      registrationId: registration.id,
      registrationVersion: registration.version,
      source: { kind: 'recovery', key: 'cleanup-after-merge' },
      idempotencyKey: 'cleanup-after-merge',
      jobType: 'release-receipt-test',
      payload: { releaseId },
    });
    await store.linkJobToRelease({
      jobId: cleanupJob.job.id,
      releaseId,
    });
    const cleanupLease = await store.acquireLease({
      workerId: 'cleanup-after-merge',
      durationMs: 10_000,
    });
    await expect(store.failOrRetryLease({
      token: cleanupLease!.token,
      workerId: 'cleanup-after-merge',
      failure: {
        schemaVersion: 1,
        status: 'failed',
        code: 'release_failure',
        message: 'post-merge cleanup was interrupted',
        retryable: true,
        boundary: 'release',
        observedAt: '2026-08-01T00:08:00Z',
      },
      retryDelayMs: 0,
      maxAttempts: 3,
    })).resolves.toBe('succeeded');
    const converged = await pool.query<{
      job_status: string;
      attempt_status: string;
      result: Record<string, unknown>;
      event_type: string;
    }>(
      `SELECT j.status AS job_status, a.status AS attempt_status, j.result,
              audit.event_type
         FROM agentops_control.jobs j
         JOIN agentops_control.job_attempts a ON a.job_id = j.id
         JOIN agentops_control.runtime_audit audit ON audit.job_id = j.id
        WHERE j.id = $1
          AND audit.event_type = 'runner.attempt.cleanup_ignored_after_merge'`,
      [cleanupJob.job.id],
    );
    expect(converged.rows[0]).toMatchObject({
      job_status: 'succeeded',
      attempt_status: 'succeeded',
      result: {
        status: 'succeeded',
        headSha: head,
        pullRequestNumber: 21,
      },
      event_type: 'runner.attempt.cleanup_ignored_after_merge',
    });

    const outbox = await store.listReleaseReceipts(releaseId, {
      includeMergeIntent: true,
    });
    expect(outbox.map((entry) => entry.receipt.kind)).toEqual([
      'authority',
      'build',
      'grade',
      'grade',
      'review',
      'review',
      'runtime-provenance',
      'merge-intent',
      'merge',
    ]);
    expect(outbox.every((entry) => entry.publishedAt === null)).toBe(true);
    await store.markReleaseReceiptPublished(authorityId);
    expect((await store.listReleaseReceipts(releaseId, {
      includeMergeIntent: true,
    }))[0]?.publishedAt).not.toBeNull();
  });

  it('fails closed for a required AI authority and for mixed release identity', async () => {
    const registration = await store.createRegistration({
      repository: 'sample/strict-target',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: {},
    });
    const created = await store.createRelease({
      registrationId: registration.id,
      registrationVersion: registration.version,
      releaseKey: 'issue:8:release:1',
      repository: registration.repository,
      issueNumber: 8,
      policy: {
        authority: 'ai-triage-required',
        requiredGateSignals: [{ source: 'github-check', name: 'test' }],
        requiredReviewPerspectives: ['security', 'correctness'],
        minimumHeadEpochs: 1,
      },
    });
    const strictAt = (seconds: number) => new Date(
      Date.parse(created.release.createdAt) + seconds * 1_000,
    ).toISOString();
    const authority = {
      receiptId: randomUUID(),
      receiptKey: 'authority:human-ready',
      releaseId: created.release.id,
      repository: registration.repository,
      issueNumber: 8,
      producer: {},
      causes: [],
      recordedAt: strictAt(1),
      kind: 'authority' as const,
      route: 'human-ready' as const,
      actor: { type: 'human' as const, login: 'maintainer' },
      readyLabel: 'ready',
      readyAt: strictAt(1),
    };
    await store.recordReleaseReceipt(authority);
    await expect(store.recordReleaseReceipt({
      ...authority,
      receiptId: randomUUID(),
      receiptKey: 'authority:mixed',
      releaseId: randomUUID(),
    })).rejects.toThrow();
    await expect(store.authorizeReleaseMerge({
      releaseId: created.release.id,
      intent: {
        receiptId: randomUUID(),
        receiptKey: 'merge-intent:22',
        releaseId: created.release.id,
        repository: registration.repository,
        issueNumber: 8,
        producer: {},
        causes: [authority.receiptId],
        recordedAt: strictAt(2),
        kind: 'merge-intent',
        pullRequest: 22,
        expectedHead: 'e'.repeat(40),
        observedPrHead: 'e'.repeat(40),
      },
    })).rejects.toBeInstanceOf(ReleaseCertificationError);
    await expect(store.createRelease({
      registrationId: registration.id,
      registrationVersion: registration.version,
      releaseKey: 'issue:8:release:changed',
      repository: registration.repository,
      issueNumber: 8,
      policy: {
        authority: 'human-ready-allowed',
        requiredGateSignals: [{ source: 'github-check', name: 'test' }],
        requiredReviewPerspectives: ['security', 'correctness'],
        minimumHeadEpochs: 1,
      },
    })).rejects.toBeInstanceOf(ReleaseReceiptConflictError);
  });

  it('creates and links a direct-human release during atomic promotion', async () => {
    const policy = {
      authority: 'human-ready-allowed' as const,
      requiredGateSignals: [{ source: 'github-check' as const, name: 'test' }],
      requiredReviewPerspectives: ['security', 'correctness'],
      minimumHeadEpochs: 1,
    };
    const registration = await store.createRegistration({
      repository: 'sample/promotion-v2',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: { releaseEvidence: policy },
    });
    const queued = await store.enqueueJob({
      registrationId: registration.id,
      registrationVersion: registration.version,
      source: { kind: 'poll', key: 'issue:31' },
      idempotencyKey: 'issue:31',
      jobType: 'agentops.triage',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'promotion-v2' },
        issue: {
          number: 31,
          observedUpdatedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    const lease = await store.acquireLease({
      workerId: 'triage-direct-human',
      durationMs: 10_000,
      jobType: 'agentops.triage',
    });
    const result = {
      schemaVersion: 1,
      status: 'succeeded',
      jobId: queued.job.id,
      attemptNumber: lease!.attemptNumber,
      repository: registration.repository,
      issueNumber: 31,
      outcome: 'promoted',
      sourceDigest: null,
      decision: null,
      commentUrl: null,
      appliedLabels: [],
      promotedJobId: null,
      providerProvenance: null,
      completedAt: '2026-08-01T00:00:31Z',
    };
    const triage = await pool.connect();
    let promotedJobId: string;
    try {
      await triage.query('SET ROLE agentops_triage');
      const promoted = await triage.query<{ job_id: string }>(
        `SELECT job_id
           FROM agentops_control.promote_triage_release($1, $2, $3, $4, $5, $6)`,
        [
          lease!.token,
          'triage-direct-human',
          result,
          'ready',
          'claimed',
          { actor: 'product-owner', readyAt: '2026-08-01T00:00:30Z' },
        ],
      );
      promotedJobId = promoted.rows[0]!.job_id;
    } finally {
      await triage.query('RESET ROLE');
      triage.release();
    }
    const linked = await pool.query<{
      id: string;
      release_id: string;
      status: string;
    }>(
      `SELECT id, release_id, status
         FROM agentops_control.jobs
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[queued.job.id, promotedJobId]],
    );
    expect(new Set(linked.rows.map((row) => row.release_id)).size).toBe(1);
    expect(linked.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: queued.job.id, status: 'succeeded' }),
      expect.objectContaining({ id: promotedJobId, status: 'queued' }),
    ]));
    const runner = await pool.connect();
    try {
      await runner.query('SET ROLE agentops_runner');
      const locked = await runner.query<{
        status: string;
        final_head: string | null;
        pull_request_number: string | null;
      }>(
        `SELECT status, final_head, pull_request_number
           FROM agentops_control.lock_release_completion_state($1, $2)`,
        [promotedJobId, linked.rows[0]!.release_id],
      );
      expect(locked.rows).toEqual([{
        status: 'collecting',
        final_head: null,
        pull_request_number: null,
      }]);
      const bound = await runner.query<{ pull_request_number: string }>(
        `SELECT agentops_control.bind_release_pull_request($1, $2, $3)
           AS pull_request_number`,
        [promotedJobId, linked.rows[0]!.release_id, 91],
      );
      expect(bound.rows).toEqual([{ pull_request_number: '91' }]);
    } finally {
      await runner.query('RESET ROLE');
      runner.release();
    }
    const receipt = (await store.listReleaseReceipts(
      linked.rows[0]!.release_id,
    ))[0]!.receipt;
    expect(receipt).toMatchObject({
      kind: 'authority',
      route: 'human-ready',
      actor: { type: 'human', login: 'product-owner' },
    });
    expect(receipt).not.toHaveProperty('triageInvocationId');
    await expect(store.findReleaseForRunnerEvent({
      registrationId: registration.id,
      pullRequest: 91,
    })).resolves.toMatchObject({ id: linked.rows[0]!.release_id });
  });

  it('fails promotion closed until a required pre-ready AI decision is proven', async () => {
    const policy = {
      authority: 'ai-triage-required' as const,
      requiredGateSignals: [{ source: 'github-check' as const, name: 'test' }],
      requiredReviewPerspectives: ['security', 'correctness'],
      minimumHeadEpochs: 1,
    };
    const registration = await store.createRegistration({
      repository: 'sample/strict-promotion',
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
      configuration: { releaseEvidence: policy },
    });
    const queued = await store.enqueueJob({
      registrationId: registration.id,
      registrationVersion: registration.version,
      source: { kind: 'poll', key: 'issue:32' },
      idempotencyKey: 'issue:32',
      jobType: 'agentops.triage',
      payload: {
        schemaVersion: 1,
        repository: { owner: 'sample', name: 'strict-promotion' },
        issue: {
          number: 32,
          observedUpdatedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    const lease = await store.acquireLease({
      workerId: 'triage-ai-required',
      durationMs: 10_000,
      jobType: 'agentops.triage',
    });
    const result = {
      schemaVersion: 1 as const,
      status: 'succeeded' as const,
      jobId: queued.job.id,
      attemptNumber: lease!.attemptNumber,
      repository: registration.repository,
      issueNumber: 32,
      outcome: 'promoted' as const,
      sourceDigest: null,
      decision: null,
      commentUrl: null,
      appliedLabels: [],
      promotedJobId: null,
      providerProvenance: null,
      completedAt: '2026-08-01T00:00:31Z',
    };
    await expect(store.promoteTriageLease({
      token: lease!.token,
      workerId: 'triage-ai-required',
      readyLabel: 'ready',
      claimedLabel: 'claimed',
      authority: {
        actor: 'product-owner',
        readyAt: '2026-08-01T00:00:30Z',
      },
      result,
    })).rejects.toThrow(/AI triage receipt is required/);
    const rolledBack = await pool.query<{
      status: string;
      release_id: string | null;
      promoted_count: string;
    }>(
      `SELECT triage.status, triage.release_id,
              (SELECT count(*)::text
                 FROM agentops_control.jobs promoted
                WHERE promoted.registration_id = triage.registration_id
                  AND promoted.job_type = 'agentops.runner') AS promoted_count
         FROM agentops_control.jobs triage
        WHERE triage.id = $1`,
      [queued.job.id],
    );
    expect(rolledBack.rows[0]).toEqual({
      status: 'leased',
      release_id: null,
      promoted_count: '0',
    });

    const decision = {
      schemaVersion: 1 as const,
      type: 'feature' as const,
      northStarAlignment: 'aligned' as const,
      readiness: 'ready_candidate' as const,
      priority: 'p1' as const,
      summary: 'Ready after AI triage.',
      rationale: ['The request and acceptance contract are complete.'],
      dependencies: [],
      duplicateCandidates: [],
      missingInformation: [],
    };
    const promotedJobId = await store.promoteTriageLease({
      token: lease!.token,
      workerId: 'triage-ai-required',
      readyLabel: 'ready',
      claimedLabel: 'claimed',
      authority: {
        actor: 'product-owner',
        readyAt: '2026-08-01T00:00:30Z',
        triage: {
          sourceDigest: 'f'.repeat(64),
          decision,
          completedAt: '2026-08-01T00:00:20Z',
          providerProvenance: {
            attemptId: lease!.attemptId,
            provider: 'codex',
            model: { kind: 'explicit', name: 'gpt-5' },
            consumer: {
              repository: 'mrbaron3/servo',
              revision: 'c'.repeat(40),
            },
            environment: {
              kind: 'container',
              reference: 'ghcr.io/mrbaron3/agentops@sha256:triage',
              digest: `sha256:${'d'.repeat(64)}`,
            },
          },
        },
      },
      result,
    });
    const promoted = await pool.query<{ release_id: string }>(
      `SELECT release_id FROM agentops_control.jobs WHERE id = $1`,
      [promotedJobId],
    );
    const receipt = (await store.listReleaseReceipts(
      promoted.rows[0]!.release_id,
    ))[0]!.receipt;
    expect(receipt).toMatchObject({
      kind: 'authority',
      route: 'ai-triage-then-human-ready',
      triageInvocationId: `triage-job:${queued.job.id}`,
      triageCompletedAt: '2026-08-01T00:00:20.000000Z',
      sourceDigest: 'f'.repeat(64),
    });
  });
});
