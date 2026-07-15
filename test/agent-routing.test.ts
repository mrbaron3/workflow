/** FEAT-015 — deterministic role/perspective provider+model routing. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  AgentRouteResolutionError,
  resolveAgentRoute,
  resolvedGeneratorProvider,
} from '../src/agents/routing.js';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { assignIssue } from '../src/pipeline/assign.js';
import { adoptIssue } from '../src/pipeline/adopt.js';
import { isAiManaged } from '../src/pipeline/execution/guard.js';
import { reviewerSessionInvocations, reviewJobPaths } from '../src/pipeline/execution/perspective-session.js';

const roots: string[] = [];
function storeAt(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-routing-'));
  roots.push(root);
  return new Store(root);
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveAgentRoute', () => {
  it('AC-AGROUTE-001 preserves legacy generator and reviewer defaults', () => {
    const config: HarnessConfig = {
      ...DEFAULT_CONFIG,
      generator: 'codex',
      models: { generator: 'gpt-5.1-codex', reviewer: 'sonnet' },
    };
    expect(resolveAgentRoute(config, 'generator')).toEqual({ provider: 'codex', model: 'gpt-5.1-codex' });
    expect(resolveAgentRoute(config, 'reviewer', 'security')).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('AC-AGROUTE-002 resolves independent role defaults', () => {
    const config: HarnessConfig = {
      ...DEFAULT_CONFIG,
      routes: {
        generator: { provider: 'codex', model: 'gpt-5.1-codex' },
        reviewer: { provider: 'claude', model: 'opus' },
        planning: { provider: 'codex', model: 'o3' },
        uiDesign: { provider: 'claude', model: 'sonnet' },
      },
    };
    expect(resolveAgentRoute(config, 'generator')).toEqual(config.routes!.generator);
    expect(resolveAgentRoute(config, 'reviewer', 'ux')).toEqual(config.routes!.reviewer);
    expect(resolveAgentRoute(config, 'planning')).toEqual(config.routes!.planning);
    expect(resolveAgentRoute(config, 'ui-design')).toEqual(config.routes!.uiDesign);
  });

  it('falls back from UI design to planning, then the legacy generator route', () => {
    const planned: HarnessConfig = {
      ...DEFAULT_CONFIG,
      routes: { planning: { provider: 'codex', model: 'o3' } },
    };
    expect(resolveAgentRoute(planned, 'ui-design')).toEqual({ provider: 'codex', model: 'o3' });
    expect(resolveAgentRoute({ ...DEFAULT_CONFIG, generator: 'claude' }, 'ui-design'))
      .toEqual({ provider: 'claude', model: null });
  });

  it('AC-AGROUTE-003 gives a perspective route precedence over reviewer default only for that lens', () => {
    const config: HarnessConfig = {
      ...DEFAULT_CONFIG,
      routes: {
        reviewer: { provider: 'claude', model: 'sonnet' },
        perspectives: { security: { provider: 'codex', model: 'gpt-5.1-codex' } },
      },
    };
    expect(resolveAgentRoute(config, 'reviewer', 'security')).toEqual({ provider: 'codex', model: 'gpt-5.1-codex' });
    expect(resolveAgentRoute(config, 'reviewer', 'codeQuality')).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('AC-AGROUTE-004 fails closed for malformed selected routes', () => {
    for (const route of [{ model: 'x' }, { provider: 'unknown' }, { provider: 'codex', model: 42 }]) {
      const config = { ...DEFAULT_CONFIG, routes: { reviewer: route } } as unknown as HarnessConfig;
      expect(() => resolveAgentRoute(config, 'reviewer', 'security')).toThrow(AgentRouteResolutionError);
    }
  });
});

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'works', verification: { method: 'unit_test' as const, expected: ['pass'] } },
  ],
  redLines: [],
};

describe('route wiring', () => {
  it('AC-AGROUTE-005 uses the resolved generator provider for assignment, adoption, and polling', () => {
    const config: HarnessConfig = {
      ...DEFAULT_CONFIG,
      generator: 'claude',
      routes: { generator: { provider: 'codex', model: 'gpt-5.1-codex' } },
    };
    const store = storeAt();
    store.addIssue(Issue.parse({
      id: 'ISSUE-A', type: 'feature', title: 'drafted', area: 'harness', status: 'contract-drafted',
      contract, createdAt: nowISO(), updatedAt: nowISO(),
    }));
    store.addIssue(Issue.parse({
      id: 'ISSUE-B', type: 'harness', title: 'proposal', area: 'harness', status: 'planned',
      contract, createdAt: nowISO(), updatedAt: nowISO(),
    }));

    expect(resolvedGeneratorProvider(config)).toBe('codex');
    const assigned = assignIssue(store, config, 'ISSUE-A');
    const adopted = adoptIssue(store, config, 'ISSUE-B');
    expect(assigned.assignedAgent).toBe('codex');
    expect(adopted.assignedAgent).toBe('codex');
    expect(isAiManaged(assigned, config)).toBe(true);
    expect(isAiManaged({ ...assigned, assignedAgent: 'claude' }, config)).toBe(false);
  });

  it('AC-AGROUTE-006 projects mixed reviewer routes per perspective', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-route-review-'));
    roots.push(root);
    const jobs = ['security', 'codeQuality'].map((perspective) => {
      const job = reviewJobPaths(path.join(root, 'worktrees'), path.join(root, 'evidence'), 'issue-a-s0', perspective);
      fs.mkdirSync(path.dirname(job.prompt), { recursive: true });
      fs.writeFileSync(job.prompt, `${perspective} prompt`, 'utf8');
      return job;
    });
    const routes = {
      security: { provider: 'codex' as const, model: 'gpt-5.1-codex' },
      codeQuality: { provider: 'claude' as const, model: 'sonnet' },
    };

    expect(reviewerSessionInvocations(jobs, ['completed', 'completed'], routes)).toEqual([
      { role: 'reviewer', perspective: 'security', provider: 'codex', model: 'gpt-5.1-codex', prompt: 'security prompt', outcome: 'completed' },
      { role: 'reviewer', perspective: 'codeQuality', provider: 'claude', model: 'sonnet', prompt: 'codeQuality prompt', outcome: 'completed' },
    ]);
  });
});
