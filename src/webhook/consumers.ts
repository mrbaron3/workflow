import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from '../config.js';
import type { NormalizedGithubEvent, WebhookConsumer, WebhookConsumerEvent } from './schema.js';
import type { WebhookConsumerHandlers } from './router.js';
import { WebhookControlStore } from './store.js';

export interface WebhookConsumerAdapterOptions {
  harnessRoot: string;
  orcaSyncScript?: string;
  log?: (message: string) => void;
  runProcess?: (
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<void>;
}

const CONSUMER_ENV_ALLOWLIST = new Set([
  'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'HOME', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'NODE_EXTRA_CA_CERTS', 'PATH', 'SHELL', 'SSH_AUTH_SOCK',
  'TMPDIR', 'TMP', 'TEMP', 'USER', 'XDG_CONFIG_HOME',
]);

export function sanitizedConsumerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) =>
      CONSUMER_ENV_ALLOWLIST.has(name) && value !== undefined),
  );
}

export function productionProcessRunner(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${path.basename(executable)} exited with `
        + (code === null ? `signal ${signal ?? 'unknown'}` : `status ${code}`),
      ));
    });
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function orcaSyncArgs(event: WebhookConsumerEvent): string[] | null {
  if (event.source === 'reconciliation') return null;
  if (event.event === 'pull_request' && event.action === 'closed') {
    const pr = object(event.payload.pull_request);
    if (!pr?.merged) return null;
    const head = stringField(object(pr.head)?.ref);
    const base = stringField(object(pr.base)?.ref);
    if (!head || !base) throw new Error('merged pull_request payload is missing head/base refs');
    return ['--event', 'pr-merged', '--head', head, '--base', base];
  }
  if (event.event === 'push' && !event.payload.deleted) {
    const branch = stringField(event.payload.ref).replace(/^refs\/heads\//, '');
    if (!branch) throw new Error('push payload is missing a branch ref');
    return ['--event', 'push', '--branch', branch];
  }
  return null;
}

/**
 * Fixed, allow-listed adapters. Repository registrations select adapters by
 * name; they cannot inject an executable or shell command.
 */
export function createWebhookConsumerAdapters(
  store: WebhookControlStore,
  options: WebhookConsumerAdapterOptions,
): Record<WebhookConsumer, NonNullable<WebhookConsumerHandlers[WebhookConsumer]>> {
  const log = options.log ?? (() => {});
  const runProcess = options.runProcess ?? productionProcessRunner;
  const inFlightAgentOps = new Map<string, Promise<void>>();
  const consumerEnv = sanitizedConsumerEnvironment();

  return {
    agentops: async (event) => {
      const registration = store.snapshot().repositories.find((row) => row.id === event.registrationId);
      if (!registration) throw new Error(`repository registration disappeared: ${event.registrationId}`);
      const workspaceRoot = registration.workspaceRoot ?? options.harnessRoot;
      const config = loadConfig(workspaceRoot);
      if (!config.intake || config.intake.repository.toLowerCase() !== event.repository) {
        throw new Error(
          `workspace ${workspaceRoot} is not configured for GitHub intake ${event.repository}`,
        );
      }
      const launcher = path.join(options.harnessRoot, 'bin', 'agentops.mjs');
      const previous = inFlightAgentOps.get(registration.id) ?? Promise.resolve();
      const current = previous
        .catch(() => {})
        .then(async () => {
          log(
            event.source === 'reconciliation'
              ? `agentops reconcile: ${event.repository}`
              : `agentops wake: ${event.repository} ${event.event}/${event.action ?? '-'}`,
          );
          await runProcess(process.execPath, [launcher, 'github-turn'], {
            cwd: workspaceRoot,
            env: consumerEnv,
          });
        });
      inFlightAgentOps.set(registration.id, current);
      try {
        await current;
      } finally {
        if (inFlightAgentOps.get(registration.id) === current) {
          inFlightAgentOps.delete(registration.id);
        }
      }
    },
    'orca-worktree-sync': async (event) => {
      const args = orcaSyncArgs(event);
      if (!args) return;
      if (!options.orcaSyncScript) {
        throw new Error(
          'orca-worktree-sync consumer requires --orca-sync-script or AGENTOPS_ORCA_SYNC_SCRIPT',
        );
      }
      log(`orca sync: ${event.repository} ${args.join(' ')}`);
      await runProcess(options.orcaSyncScript, args, {
        cwd: options.harnessRoot,
        env: consumerEnv,
      });
    },
  };
}
