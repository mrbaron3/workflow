import { parentPort, workerData } from 'node:worker_threads';
import { Pool } from 'pg';
import { z } from 'zod';

const Input = z.object({
  connectionString: z.string().min(1),
  token: z.string().uuid(),
  workerId: z.string().min(1),
  durationMs: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
}).strict();

const input = Input.parse(workerData);
const pool = new Pool({
  connectionString: input.connectionString,
  max: 1,
  connectionTimeoutMillis: 3_000,
  application_name: `agentops-runner-heartbeat:${input.workerId}`,
});
let timer: NodeJS.Timeout | null = null;
let stopping = false;
let inFlight: Promise<void> | null = null;
let poolEnded = false;

async function closePool(): Promise<void> {
  if (poolEnded) return;
  poolEnded = true;
  await pool.end();
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
  await closePool();
  parentPort?.postMessage({ type: 'stopped' });
  parentPort?.close();
}

async function heartbeat(): Promise<void> {
  const result = await pool.query(
    `UPDATE agentops_control.job_leases
        SET heartbeat_at = clock_timestamp(),
            expires_at = clock_timestamp() + ($3 * interval '1 millisecond')
      WHERE lease_token = $1 AND worker_id = $2
        AND status = 'active' AND expires_at > clock_timestamp()
      RETURNING expires_at`,
    [input.token, input.workerId, input.durationMs],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error('lease is absent, inactive, expired, or owned by another worker');
  }
}

function schedule(): void {
  timer = setInterval(() => {
    if (stopping || inFlight) return;
    inFlight = heartbeat()
      .catch((error: unknown) => {
        parentPort?.postMessage({
          type: 'lost',
          message: error instanceof Error ? error.message : String(error),
        });
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
      })
      .finally(async () => {
        inFlight = null;
        if (stopping) {
          await closePool();
          parentPort?.postMessage({ type: 'stopped' });
          parentPort?.close();
        }
      });
  }, input.intervalMs);
}

parentPort?.on('message', (message: unknown) => {
  if (
    message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === 'stop'
  ) {
    void stop();
  }
});
schedule();
