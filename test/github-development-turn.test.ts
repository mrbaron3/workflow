/** FEAT-018 — the compositional vertical slice, with external/provider/drive seams faked. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { GithubIssueSnapshot, PR } from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';
import type { GithubIssueRunner } from '../src/intake/github-issues.js';
import {
  DEFAULT_GITHUB_WATCH_INTERVAL_MS,
  MAX_GITHUB_WATCH_INTERVAL_MS,
  runGithubDevelopmentTurn,
  watchGithubDevelopment,
} from '../src/intake/development-turn.js';
import { pollable } from '../src/pipeline/execution/guard.js';

const roots: string[] = [];
function setup(): { store: Store; config: HarnessConfig; runner: FakeIssueRunner } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-github-turn-'));
  roots.push(root);
  const store = new Store(root);
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    generator: 'claude',
    routes: {
      generator: { provider: 'codex', model: 'gpt-5.1-codex' },
      planning: { provider: 'claude', model: 'opus' },
      uiDesign: { provider: 'codex', model: 'gpt-5.1-codex' },
      reviewer: { provider: 'claude', model: 'sonnet' },
      perspectives: { security: { provider: 'codex', model: 'gpt-5.1-codex' } },
    },
    intake: { backend: 'github', repository: 'acme/theme', readyLabel: 'ready', claimedLabel: 'agent-claimed' },
  };
  const runner = new FakeIssueRunner();
  return { store, config, runner };
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

class FakeIssueRunner implements GithubIssueRunner {
  claims = 0;
  issue = GithubIssueSnapshot.parse({
    repository: 'acme/theme', number: 42, externalId: 'I_42', title: 'Add CSV export',
    body: 'Users must export a report as CSV.', url: 'https://github.com/acme/theme/issues/42',
    labels: ['ready'], state: 'open', sourceUpdatedAt: '2026-07-14T00:00:00.000Z', snapshotAt: '2026-07-14T01:00:00.000Z',
  });
  listReadyIssues() { return [this.issue]; }
  claimIssue() { this.claims += 1; }
}

const validOutput = {
  candidates: [{
    candidateKey: 'csv-export', title: 'Implement CSV export', type: 'feature' as const, area: 'backend' as const,
    contract: {
      productGoal: 'Export reports', userStory: 'As a user I export CSV', scope: { include: ['src/**'], exclude: [] },
      acceptanceCriteria: [{
        id: 'AC-CSV-001', severity: 'blocker' as const, behavior: 'CSV export works',
        verification: { method: 'unit_test' as const, expected: ['CSV returned'] },
      }],
      redLines: [],
    },
    traces: [{ criterionId: 'AC-CSV-001', sources: [{ kind: 'source' as const, text: 'export a report as CSV' }] }],
  }],
  ambiguities: [],
};

const validUiOutput = {
  artifact: {
    candidateKey: 'csv-export',
    principles: ['Reuse the existing action hierarchy'],
    tokens: [{
      id: 'space-export', category: 'spacing' as const, value: 'var(--space-3)',
      rationale: 'Matches adjacent actions', sourceCriterionIds: ['AC-CSV-001'],
    }],
    components: [{
      id: 'export-action', name: 'Export action', purpose: 'Starts CSV export',
      states: ['idle', 'loading', 'error'], interactions: ['activate to export'],
      accessibility: ['announces loading state'], sourceCriterionIds: ['AC-CSV-001'],
    }],
    criterionTraces: [{ criterionId: 'AC-CSV-001', designElementIds: ['space-export', 'export-action'] }],
  },
  ambiguities: [],
};

describe('GitHub development turn', () => {
  it('AC-GWATCH-001 uses the configured recurring poll interval', async () => {
    const env = setup();
    env.config.intake!.pollIntervalMs = 12_345;
    const events: string[] = [];
    let sleepCount = 0;
    const stopped = new Error('stop watcher');

    await expect(watchGithubDevelopment(env.store, env.config, {
      issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
      driveQueue: async () => { events.push('turn'); return []; },
    }, process.cwd(), () => {}, {
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        sleepCount += 1;
        if (sleepCount === 2) throw stopped;
      },
    })).rejects.toBe(stopped);

    expect(events).toEqual(['turn', 'sleep:12345', 'turn', 'sleep:12345']);
  });

  it('AC-GWATCH-002 gives the explicit watcher interval precedence over config', async () => {
    const env = setup();
    env.config.intake!.pollIntervalMs = 12_345;
    const sleeps: number[] = [];
    const stopped = new Error('stop watcher');

    await expect(watchGithubDevelopment(env.store, env.config, {
      issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
      driveQueue: async () => [],
    }, process.cwd(), () => {}, {
      intervalMs: 678,
      sleep: async (ms) => { sleeps.push(ms); throw stopped; },
    })).rejects.toBe(stopped);

    expect(sleeps).toEqual([678]);
  });

  it('AC-GWATCH-003 falls back to the pinned 30000 ms interval for absent or invalid config', async () => {
    expect(DEFAULT_GITHUB_WATCH_INTERVAL_MS).toBe(30_000);
    const values = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];

    for (const value of values) {
      const env = setup();
      env.config.intake!.pollIntervalMs = value;
      const sleeps: number[] = [];
      const stopped = new Error('stop watcher');
      await expect(watchGithubDevelopment(env.store, env.config, {
        issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
        driveQueue: async () => [],
      }, process.cwd(), () => {}, {
        sleep: async (ms) => { sleeps.push(ms); throw stopped; },
      })).rejects.toBe(stopped);
      expect(sleeps, `configured value ${String(value)}`).toEqual([30_000]);
    }
  });

  it('AC-GWATCH-003 treats intervals above the Node timer maximum as invalid, accepting the boundary', async () => {
    expect(MAX_GITHUB_WATCH_INTERVAL_MS).toBe(2_147_483_647);
    const cases: Array<[configured: number, slept: number]> = [
      [MAX_GITHUB_WATCH_INTERVAL_MS, MAX_GITHUB_WATCH_INTERVAL_MS],
      [MAX_GITHUB_WATCH_INTERVAL_MS + 1, DEFAULT_GITHUB_WATCH_INTERVAL_MS],
    ];

    for (const [configured, slept] of cases) {
      const env = setup();
      env.config.intake!.pollIntervalMs = configured;
      const sleeps: number[] = [];
      const stopped = new Error('stop watcher');
      await expect(watchGithubDevelopment(env.store, env.config, {
        issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
        driveQueue: async () => [],
      }, process.cwd(), () => {}, {
        sleep: async (ms) => { sleeps.push(ms); throw stopped; },
      })).rejects.toBe(stopped);
      expect(sleeps, `configured value ${configured}`).toEqual([slept]);
    }
  });

  it('AC-GWATCH-004 runs one shot without invoking watcher sleep', async () => {
    const env = setup();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const result = await runGithubDevelopmentTurn(env.store, env.config, {
        issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
        driveQueue: async () => [],
      });

      expect(result).toEqual({ intake: [], enrichmentIds: [], driveResults: [] });
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('AC-GWATCH-005 exposes optional and numeric pollIntervalMs through default and configured intervals', async () => {
    const observed: number[] = [];

    for (const pollIntervalMs of [undefined, 2_468] as const) {
      const env = setup();
      if (pollIntervalMs === undefined) delete env.config.intake!.pollIntervalMs;
      else env.config.intake!.pollIntervalMs = pollIntervalMs;
      const stopped = new Error('stop watcher');

      await expect(watchGithubDevelopment(env.store, env.config, {
        issueRunner: { listReadyIssues: () => [], claimIssue: () => {} },
        driveQueue: async () => [],
      }, process.cwd(), () => {}, {
        sleep: async (ms) => { observed.push(ms); throw stopped; },
      })).rejects.toBe(stopped);
    }

    expect(observed).toEqual([DEFAULT_GITHUB_WATCH_INTERVAL_MS, 2_468]);
  });

  it('AC-GWATCH-006 documents pollIntervalMs and its named default fallback', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('`intake.pollIntervalMs`');
    expect(readme).toContain('`DEFAULT_GITHUB_WATCH_INTERVAL_MS`');
    expect(readme).toMatch(/omitted or invalid[\s\S]*`DEFAULT_GITHUB_WATCH_INTERVAL_MS`/);
  });

  it('AC-GHSLICE-001/005 composes claim → planning provenance → queue → existing drive/PR projection', async () => {
    const env = setup();
    const events: string[] = [];
    const result = await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async ({ route }) => {
        events.push(`plan:${route.provider}/${route.model}`);
        return { provider: route.provider, model: route.model, prompt: 'planning prompt', outcome: 'completed', output: validOutput };
      },
      driveQueue: async () => {
        const queue = pollable(env.store, env.config);
        events.push(`drive:${queue.map((issue) => issue.id).join(',')}`);
        const issue = queue[0]!;
        env.store.addPR(PR.parse({
          id: 'PR-0001', issueId: issue.id, branch: 'agent/csv-export', generator: 'codex',
          externalRef: { provider: 'github', number: 77, url: 'https://github.com/acme/theme/pull/77' },
          createdAt: nowISO(), updatedAt: nowISO(),
        }));
        return [];
      },
    });

    expect(events).toEqual(['plan:claude/opus', 'drive:ISSUE-0001']);
    expect(result.enrichmentIds).toHaveLength(1);
    expect(env.store.db.agentInvocations[0]!.role).toBe('issue-planner');
    const issue = env.store.db.issues[0]!;
    expect(issue.intakeKey).toBe(env.store.db.intakeRecords[0]!.intakeKey);
    expect(env.store.db.prs[0]!.issueId).toBe(issue.id);
    expect(env.store.db.prs[0]!.externalRef?.url).toContain('/pull/77');
  });

  it('AC-GHSLICE-003 rejects ambiguous planning before the drive queue', async () => {
    const env = setup();
    let driven = -1;
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async ({ route }) => ({
        provider: route.provider, model: route.model, prompt: 'ambiguous planning', outcome: 'completed',
        output: { ...validOutput, ambiguities: ['CSV delimiter is unspecified'] },
      }),
      driveQueue: async () => {
        driven = pollable(env.store, env.config).length;
        return [];
      },
    });
    expect(driven).toBe(0);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.intakeRecords[0]!.status).toBe('needs-human-review');
    expect(env.store.db.prs).toEqual([]);
  });

  it('AC-GHSLICE-004 reuses claim/enrichment/Issue and never restarts the planner', async () => {
    const env = setup();
    let planningCalls = 0;
    const planningRunner = async ({ route }: { route: { provider: 'claude' | 'codex' | 'gemini' | 'mock'; model: string | null } }) => {
      planningCalls += 1;
      return { provider: route.provider, model: route.model, prompt: 'planning prompt', outcome: 'completed' as const, output: validOutput };
    };
    await runGithubDevelopmentTurn(env.store, env.config, { issueRunner: env.runner, planningRunner, driveQueue: async () => [] });
    const counters = { ...env.store.db.counters };
    await runGithubDevelopmentTurn(env.store, env.config, { issueRunner: env.runner, planningRunner, driveQueue: async () => [] });
    expect(planningCalls).toBe(1);
    expect(env.runner.claims).toBe(1);
    expect(env.store.db.intakeRecords).toHaveLength(1);
    expect(env.store.db.planningEnrichments).toHaveLength(1);
    expect(env.store.db.issues).toHaveLength(1);
    expect(env.store.db.counters).toEqual(counters);
  });

  it('AC-GHSLICE-006 turns a failed planning session into visible human review, never release', async () => {
    const env = setup();
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async ({ route }) => ({
        provider: route.provider, model: route.model, prompt: 'planner edited source', outcome: 'failed', output: validOutput,
      }),
      driveQueue: async () => [],
    });
    expect(env.store.db.intakeRecords[0]!.status).toBe('needs-human-review');
    expect(env.store.db.planningEnrichments[0]!.reasons.join('\n')).toContain('outcome must be completed');
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.prs).toEqual([]);
  });

  it('AC-GHSLICE-006 records the actual provider but fails closed when it differs from the route', async () => {
    const env = setup();
    const logs: string[] = [];
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async () => ({
        provider: 'codex', model: 'gpt-5.1-codex', prompt: 'misrouted planner', outcome: 'completed', output: validOutput,
      }),
      driveQueue: async () => [],
    }, process.cwd(), (message) => logs.push(message));
    expect(env.store.db.agentInvocations[0]).toMatchObject({
      provider: 'codex', model: 'gpt-5.1-codex', outcome: 'failed',
    });
    expect(env.store.db.planningEnrichments[0]!.status).toBe('needs-human-review');
    expect(env.store.db.issues).toEqual([]);
    expect(logs.join('\n')).toContain('planning route mismatch');
  });

  it('runs a frontend candidate through an independently routed UI designer exactly once', async () => {
    const env = setup();
    const frontendOutput = {
      ...validOutput,
      candidates: [{ ...validOutput.candidates[0]!, area: 'frontend' as const }],
    };
    let planningCalls = 0;
    let uiCalls = 0;
    const planningRunner = async ({ route }: { route: { provider: 'claude' | 'codex' | 'gemini' | 'mock'; model: string | null } }) => {
      planningCalls += 1;
      return { provider: route.provider, model: route.model, prompt: 'planning prompt', outcome: 'completed' as const, output: frontendOutput };
    };
    const uiDesignRunner = async ({ route, candidate }: {
      route: { provider: 'claude' | 'codex' | 'gemini' | 'mock'; model: string | null };
      candidate: { candidateKey: string };
    }) => {
      uiCalls += 1;
      expect(candidate.candidateKey).toBe('csv-export');
      return { provider: route.provider, model: route.model, prompt: 'UI design prompt', outcome: 'completed' as const, output: validUiOutput };
    };
    const deps = { issueRunner: env.runner, planningRunner, uiDesignRunner, driveQueue: async () => [] };
    await runGithubDevelopmentTurn(env.store, env.config, deps);
    await runGithubDevelopmentTurn(env.store, env.config, deps);

    expect(planningCalls).toBe(1);
    expect(uiCalls).toBe(1);
    expect(env.store.db.agentInvocations.map((invocation) => invocation.role)).toEqual(['issue-planner', 'ui-designer']);
    expect(env.store.db.agentInvocations[1]).toMatchObject({ provider: 'codex', model: 'gpt-5.1-codex', outcome: 'completed' });
    expect(env.store.db.issues[0]).toMatchObject({
      area: 'frontend', uiDesign: { candidateKey: 'csv-export' },
      uiDesignInvocationKey: env.store.db.agentInvocations[1]!.invocationKey,
    });
  });

  it('does not select a malformed UI route for a backend-only planning result', async () => {
    const env = setup();
    env.config.routes!.uiDesign = { provider: 'unknown' } as never;
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async ({ route }) => ({
        provider: route.provider, model: route.model, prompt: 'backend plan', outcome: 'completed', output: validOutput,
      }),
      driveQueue: async () => [],
    });
    expect(env.store.db.planningEnrichments[0]!.status).toBe('accepted');
    expect(env.store.db.issues).toHaveLength(1);
  });

  it('records the actual UI provider but rejects a UI route mismatch before Issue creation', async () => {
    const env = setup();
    const frontendOutput = {
      ...validOutput,
      candidates: [{ ...validOutput.candidates[0]!, area: 'frontend' as const }],
    };
    const logs: string[] = [];
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: env.runner,
      planningRunner: async ({ route }) => ({
        provider: route.provider, model: route.model, prompt: 'frontend plan', outcome: 'completed', output: frontendOutput,
      }),
      uiDesignRunner: async () => ({
        provider: 'claude', model: 'opus', prompt: 'misrouted UI design', outcome: 'completed', output: validUiOutput,
      }),
      driveQueue: async () => [],
    }, process.cwd(), (message) => logs.push(message));
    expect(env.store.db.agentInvocations[1]).toMatchObject({ role: 'ui-designer', provider: 'claude', outcome: 'failed' });
    expect(env.store.db.planningEnrichments[0]!.status).toBe('needs-human-review');
    expect(env.store.db.issues).toEqual([]);
    expect(logs.join('\n')).toContain('UI design route mismatch');
  });
});
