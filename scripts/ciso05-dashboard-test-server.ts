import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { migrateControlSchema } from '../src/control-store/index.js';

const databaseUrl = process.env.AGENTOPS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('AGENTOPS_TEST_DATABASE_URL is required for dashboard browser tests');
}
const port = Number(process.env.AGENTOPS_DASHBOARD_TEST_PORT ?? '18080');
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error('AGENTOPS_DASHBOARD_TEST_PORT must be a non-privileged TCP port');
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query('DROP SCHEMA IF EXISTS agentops_control CASCADE');
  await migrateControlSchema(pool);
  await pool.query(
    `UPDATE agentops_control.lifecycle_state
        SET mode = 'ACTIVE', generation = generation + 1,
            updated_at = clock_timestamp()
      WHERE singleton`,
  );
} finally {
  await pool.end();
}

const child = spawn('go', ['run', './cmd/agentops-control'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGENTOPS_APP_ROOT: process.cwd(),
    AGENTOPS_DATABASE_URL: databaseUrl,
    AGENTOPS_CONTROL_TOKEN: 'dashboard-browser-nonbrowser-token',
    AGENTOPS_OPERATING_MODE: 'MONITOR_ONLY',
    AGENTOPS_CONTROL_LISTEN: `127.0.0.1:${port}`,
    AGENTOPS_DASHBOARD_ORIGIN: `http://127.0.0.1:${port}`,
    AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN: 'dashboard-browser-bootstrap-token',
    AGENTOPS_RECONCILIATION_INTERVAL: '500ms',
    AGENTOPS_GITHUB_POLL_INTERVAL: '1s',
    AGENTOPS_GITHUB_API_URL: 'http://127.0.0.1:9',
    AGENTOPS_RELEASE_CONSUMER_REPOSITORY: 'mrbaron3/servo',
    AGENTOPS_RELEASE_CONSUMER_REVISION: 'a'.repeat(40),
  },
  stdio: 'inherit',
});

const stop = (signal: NodeJS.Signals): void => {
  child.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
