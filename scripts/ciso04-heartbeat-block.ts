import { Worker } from 'node:worker_threads';
import { Pool } from 'pg';
import { z } from 'zod';

const Input = z.object({
  databaseUrl: z.string().url(),
  leaseToken: z.string().uuid(),
  workerId: z.string().min(1),
}).parse({
  databaseUrl: process.env.AGENTOPS_HEARTBEAT_TEST_DATABASE_URL,
  leaseToken: process.env.AGENTOPS_HEARTBEAT_TEST_LEASE_TOKEN,
  workerId: process.env.AGENTOPS_HEARTBEAT_TEST_WORKER_ID,
});

const pool = new Pool({ connectionString: Input.databaseUrl, max: 1 });
const worker = new Worker(
  new URL('../src/runner/heartbeat-worker.js', import.meta.url),
  {
    workerData: {
      connectionString: Input.databaseUrl,
      token: Input.leaseToken,
      workerId: Input.workerId,
      durationMs: 1_500,
      intervalMs: 250,
      attemptTimeoutMs: 30_000,
    },
  },
);

const waitForMessage = (type: string): Promise<void> => new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error(`heartbeat worker did not emit ${type}`)),
    5_000,
  );
  worker.on('message', (message: unknown) => {
    if (
      message
      && typeof message === 'object'
      && (message as { type?: unknown }).type === type
    ) {
      clearTimeout(timeout);
      resolve();
    }
  });
  worker.once('error', reject);
});

try {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
  const unblockedAt = Date.now();
  const lease = await pool.query<{
    active: boolean;
    heartbeat_advanced: boolean;
    remaining_ms: string;
  }>(
    `SELECT status = 'active' AND expires_at > clock_timestamp() AS active,
            heartbeat_at > acquired_at AS heartbeat_advanced,
            extract(epoch FROM (expires_at - clock_timestamp())) * 1000
              AS remaining_ms
       FROM agentops_control.job_leases
      WHERE lease_token = $1`,
    [Input.leaseToken],
  );
  const row = lease.rows[0];
  if (!row?.active || !row.heartbeat_advanced) {
    throw new Error(`independent heartbeat failed: ${JSON.stringify(row)}`);
  }
  worker.postMessage({ type: 'stop' });
  await waitForMessage('stopped');
  process.stdout.write(`${JSON.stringify({
    blockedMainThreadMs: unblockedAt - blockedAt,
    leaseActive: row.active,
    heartbeatAdvanced: row.heartbeat_advanced,
    remainingLeaseMs: Number(row.remaining_ms),
  })}\n`);
} finally {
  await worker.terminate();
  await pool.end();
}
