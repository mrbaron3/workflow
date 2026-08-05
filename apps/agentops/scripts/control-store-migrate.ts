import { Pool } from 'pg';
import { migrateControlSchema } from '../src/control-store/index.js';

async function main(): Promise<void> {
  const connectionString = process.env.AGENTOPS_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('AGENTOPS_DATABASE_URL is required; refusing to guess a control database');
  }
  const pool = new Pool({ connectionString });
  try {
    const version = await migrateControlSchema(pool);
    console.log(`control schema migrated and verified at version ${version}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
