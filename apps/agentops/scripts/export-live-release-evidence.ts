import { PostgresControlStore } from '../src/control-store/index.js';

async function main(): Promise<void> {
  const releaseId = process.argv[2]?.trim();
  if (!releaseId) {
    throw new Error('usage: export-live-release-evidence <release-id>');
  }
  const connectionString = process.env.AGENTOPS_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('AGENTOPS_DATABASE_URL is required; refusing to guess a control database');
  }
  const store = await PostgresControlStore.open({
    connectionString,
    connectionTimeoutMillis: 3_000,
    application_name: 'agentops-release-evidence-export',
  });
  try {
    const evidence = await store.exportReleaseEvidence(releaseId);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
