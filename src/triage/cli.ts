#!/usr/bin/env node
import { PostgresControlStore } from '../control-store/store.js';
import {
  inspectRunnerRuntime,
  replaceProcessEnvironment,
} from '../runner/security.js';
import { PrivateMonitorBroker } from '../runner/monitor-broker.js';
import { runCoupledLoops } from '../runner/liveness.js';
import { TypedGhTriageClient } from './github.js';
import { loadTriagePolicy } from './policy.js';
import { CliTriageProvider } from './provider.js';
import {
  loadTriageStartup,
  minimalTriageProcessEnvironment,
  minimalTriageProviderEnvironment,
} from './security.js';
import { TriageRunnerService } from './service.js';

async function main(): Promise<void> {
  const sourceEnvironment = { ...process.env };
  const { config, credentials, runtimeBoundary } = loadTriageStartup(
    sourceEnvironment,
    process.cwd(),
    inspectRunnerRuntime(),
  );
  const policy = loadTriagePolicy(sourceEnvironment);
  const store = await PostgresControlStore.open({
    connectionString: config.databaseUrl,
    max: 6,
    connectionTimeoutMillis: 3_000,
    application_name: `agentops-triage:${config.workerId}`,
  });
  const processEnvironment = minimalTriageProcessEnvironment(
    sourceEnvironment,
  );
  const providerEnvironment = minimalTriageProviderEnvironment(
    credentials,
    sourceEnvironment,
  );
  replaceProcessEnvironment(processEnvironment);
  const github = new TypedGhTriageClient(
    credentials.githubBroker,
    credentials.githubActorLogin,
  );
  const provider = new CliTriageProvider(
    config.provider,
    providerEnvironment,
    sourceEnvironment.AGENTOPS_APP_ROOT ?? '/app',
    sourceEnvironment.AGENTOPS_TRIAGE_MODEL,
    config.attemptTimeoutMs,
  );
  const service = new TriageRunnerService({
    workerId: config.workerId,
    operatingMode: config.operatingMode,
    leaseDurationMs: config.leaseDurationMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconciliationIntervalMs: config.reconciliationIntervalMs,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
    attemptTimeoutMs: config.attemptTimeoutMs,
  }, {
    store,
    github,
    provider,
    policy,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  const broker = new PrivateMonitorBroker({
    store,
    workerId: config.workerId,
    repositories: config.repositories,
    githubBroker: credentials.githubBroker,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  const drain = (): void => {
    broker.requestStop();
    service.requestDrain();
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);
  try {
    await store.appendAudit({
      actorType: 'triage',
      actorId: config.workerId,
      eventType: 'triage.startup.validated',
      details: {
        provider: config.provider,
        providerAuth: config.providerAuth,
        operatingMode: config.operatingMode,
        repositories: config.repositories,
        publishedPortCount: config.publishedPorts.length,
        mountSources: config.mounts.map((mount) => mount.source),
        outbound: config.outbound,
        kernelMountValidated: runtimeBoundary !== null,
        listeningTcpPorts: runtimeBoundary?.listeningTcpPorts ?? null,
        visibleContainerSocketPaths:
          runtimeBoundary?.visibleContainerSocketPaths ?? null,
        processEnvironmentKeys: Object.keys(process.env).sort(),
        databaseCredentialPresentInProcessEnvironment:
          process.env.AGENTOPS_TRIAGE_DATABASE_URL !== undefined,
        developmentCredentialPresentInProcessEnvironment:
          process.env.AGENTOPS_RUNNER_GITHUB_TOKEN !== undefined,
      },
    });
    await runCoupledLoops(service, broker);
  } finally {
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    await store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `agentops-triage failed closed: ${
      error instanceof Error ? error.stack : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
