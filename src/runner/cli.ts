#!/usr/bin/env node
import { PostgresControlStore } from '../control-store/store.js';
import { ExistingAgentOpsRunnerAdapter } from './adapter.js';
import {
  loadRunnerStartup,
  inspectRunnerRuntime,
  minimalExecutionEnvironment,
  replaceProcessEnvironment,
} from './security.js';
import { IsolatedRunnerService } from './service.js';
import { RunnerWorkspaceManager } from './workspace.js';
import { PrivateMonitorBroker } from './monitor-broker.js';

async function main(): Promise<void> {
  const { config, credentials, runtimeBoundary } = loadRunnerStartup(
    process.env,
    process.cwd(),
    inspectRunnerRuntime(),
  );
  const store = await PostgresControlStore.open({
    connectionString: config.databaseUrl,
    max: 6,
    connectionTimeoutMillis: 3_000,
    application_name: `agentops-runner:${config.workerId}`,
  });
  // From this point the pool owns DB connectivity. Provider/GitHub/tmux child
  // processes inherit a minimal environment with no PostgreSQL credential.
  const executionEnvironment = minimalExecutionEnvironment(credentials, process.env, {
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const monitorRepository = process.env.AGENTOPS_MONITOR_REPOSITORY;
  replaceProcessEnvironment(executionEnvironment);
  const service = new IsolatedRunnerService(
    {
      workerId: config.workerId,
      workspaceRoot: config.workspaceRoot,
      provider: config.provider,
      operatingMode: config.operatingMode,
      leaseDurationMs: config.leaseDurationMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      heartbeatDatabaseUrl: config.databaseUrl,
      reconciliationIntervalMs: config.reconciliationIntervalMs,
      maxAttempts: config.maxAttempts,
      retryBaseMs: config.retryBaseMs,
      attemptTimeoutMs: config.attemptTimeoutMs,
    },
    {
      store,
      workspace: new RunnerWorkspaceManager(
        config.workspaceRoot,
        executionEnvironment,
      ),
      adapter: new ExistingAgentOpsRunnerAdapter(),
      log: (message) => process.stdout.write(`${message}\n`),
    },
  );
  if (monitorRepository !== 'mrbaron3/workflow') {
    throw new Error('private monitor broker repository allowlist is invalid');
  }
  const broker = new PrivateMonitorBroker({
    store,
    workerId: config.workerId,
    repository: monitorRepository,
    githubToken: credentials.githubToken,
  });
  const drain = (): void => {
    broker.requestStop();
    service.requestDrain();
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);
  try {
    await store.appendAudit({
      actorType: 'runner',
      actorId: config.workerId,
      eventType: 'runner.startup.validated',
      details: {
        provider: config.provider,
        operatingMode: config.operatingMode,
        workspaceRoot: config.workspaceRoot,
        publishedPortCount: config.publishedPorts.length,
        mountSources: config.mounts.map((mount) => mount.source),
        outbound: config.outbound,
        kernelMountValidated: runtimeBoundary !== null,
        listeningTcpPorts: runtimeBoundary?.listeningTcpPorts ?? null,
        visibleContainerSocketPaths:
          runtimeBoundary?.visibleContainerSocketPaths ?? null,
        commandTimeoutMs: config.commandTimeoutMs,
        attemptTimeoutMs: config.attemptTimeoutMs,
        processEnvironmentKeys: Object.keys(process.env).sort(),
        databaseCredentialPresentInProcessEnvironment:
          process.env.AGENTOPS_RUNNER_DATABASE_URL !== undefined,
        controlCredentialPresentInProcessEnvironment:
          process.env.AGENTOPS_CONTROL_TOKEN !== undefined,
        sshAgentPresentInProcessEnvironment:
          process.env.SSH_AUTH_SOCK !== undefined,
        containerSocketPresentInProcessEnvironment:
          process.env.CONTAINER_HOST !== undefined
          || process.env.DOCKER_HOST !== undefined,
      },
    });
    await Promise.all([service.run(), broker.run()]);
  } finally {
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    await store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `agentops-runner failed closed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
