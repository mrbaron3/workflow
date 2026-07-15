/** FEAT-017 — trace-complete planning output is the only path from claimed source to queue. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { IntakeRecord } from '../src/domain/schema.js';
import { Store } from '../src/store/store.js';
import { recordAgentInvocation } from '../src/agents/invocation.js';
import {
  applyPlanningEnrichment,
  requiresUiDesign,
  uiDesignSubjectId,
} from '../src/intake/planning-enrichment.js';

const roots: string[] = [];
function setup(): { store: Store; systemDir: string; config: HarnessConfig; intakeKey: string; invocationKey: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-enrichment-'));
  roots.push(root);
  const systemDir = path.join(root, 'docs', '_system');
  fs.mkdirSync(path.join(systemDir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, 'test', 'domain-model.md'),
    '- **DOM-test-001 Stable domain rule** — retain the stable rule.\n',
    'utf8',
  );
  const store = new Store(root);
  const intakeKey = 'github:acme%2Ftheme:42';
  store.addIntakeRecord(IntakeRecord.parse({
    id: 'INTAKE-0001', intakeKey, provider: 'github', status: 'claimed',
    snapshot: {
      repository: 'acme/theme', number: 42, externalId: 'I_42', title: 'Add export action',
      body: 'Users must export a report as CSV. Keep the stable domain rule.',
      url: 'https://github.com/acme/theme/issues/42', labels: ['ready'], state: 'open',
      sourceUpdatedAt: '2026-07-14T00:00:00.000Z', snapshotAt: '2026-07-14T01:00:00.000Z',
    },
    claimedAt: '2026-07-14T01:00:01.000Z', createdAt: '2026-07-14T01:00:00.000Z', updatedAt: '2026-07-14T01:00:01.000Z',
  }));
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    routes: { generator: { provider: 'codex', model: 'gpt-5.1-codex' }, planning: { provider: 'claude', model: 'opus' } },
  };
  const invocation = recordAgentInvocation(store, {
    subjectId: intakeKey, attempt: 1, role: 'issue-planner', perspective: null,
    provider: 'claude', model: 'opus', prompt: 'enrich the immutable source', outcome: 'completed',
  });
  store.save();
  return { store, systemDir, config, intakeKey, invocationKey: invocation.invocationKey };
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function candidate(key: string, acId: string, sourceText: string) {
  return {
    candidateKey: key,
    title: `Implement ${key}`,
    type: 'feature' as const,
    area: 'backend' as const,
    contract: {
      productGoal: 'Users can export reports',
      userStory: 'As a user, I can export a report as CSV',
      scope: { include: ['src/**'], exclude: [] },
      acceptanceCriteria: [
        { id: acId, severity: 'blocker' as const, behavior: 'CSV export works', verification: { method: 'unit_test' as const, expected: ['CSV is returned'] } },
      ],
      redLines: ['Do not invent another export format'],
    },
    traces: [{ criterionId: acId, sources: [{ kind: 'source' as const, text: sourceText }] }],
  };
}

function uiOutput(candidateKey = 'ui-export', acId = 'AC-UI-001') {
  return {
    artifact: {
      candidateKey,
      principles: ['Reuse the established interaction language'],
      tokens: [{
        id: 'space-action', category: 'spacing' as const, value: 'var(--space-3)',
        rationale: 'Keeps action spacing consistent', sourceCriterionIds: [acId],
      }],
      components: [{
        id: 'export-action', name: 'Export action', purpose: 'Starts CSV export',
        states: ['idle', 'loading', 'error'], interactions: ['activate to export'],
        accessibility: ['has an accessible name', 'announces loading state'], sourceCriterionIds: [acId],
      }],
      criterionTraces: [{ criterionId: acId, designElementIds: ['space-action', 'export-action'] }],
    },
    ambiguities: [],
  };
}

function uiInvocation(env: ReturnType<typeof setup>, candidateKey = 'ui-export', outcome: 'completed' | 'failed' = 'completed') {
  return recordAgentInvocation(env.store, {
    subjectId: uiDesignSubjectId(env.intakeKey, candidateKey), attempt: 1,
    role: 'ui-designer', perspective: null, provider: 'claude', model: 'sonnet',
    prompt: 'author a UI design contract', outcome,
  });
}

describe('planning enrichment gate', () => {
  it.each(['frontend', 'fullstack'] as const)(
    'AC-UIDGATE-001/002 stops %s candidates until a dedicated UI design artifact exists',
    (area) => {
      const env = setup();
      const c = { ...candidate('ui-export', 'AC-UI-001', 'export a report as CSV'), area };
      expect(requiresUiDesign(c)).toBe(true);
      const record = applyPlanningEnrichment(
        env.store, env.config, env.intakeKey, { candidates: [c], ambiguities: [] },
        { systemDir: env.systemDir, invocationKey: env.invocationKey },
      );
      expect(record.status).toBe('needs-human-review');
      expect(record.reasons.join('\n')).toContain('UI design artifact is required');
      expect(env.store.db.issues).toEqual([]);
    },
  );

  it('AC-UIDGATE-003 keeps backend candidates on the existing accepted path', () => {
    const env = setup();
    const backend = candidate('api', 'AC-API-001', 'export a report as CSV');
    expect(requiresUiDesign(backend)).toBe(false);
    const result = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, { candidates: [backend], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(result.status).toBe('accepted');
    expect(env.store.db.issues).toHaveLength(1);
  });

  it('accepts a trace-complete UI artifact with dedicated provenance and projects it onto the Issue', () => {
    const env = setup();
    const ui = { ...candidate('ui-export', 'AC-UI-001', 'export a report as CSV'), area: 'frontend' as const };
    const invocation = uiInvocation(env);
    const record = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, { candidates: [ui], ambiguities: [] },
      {
        systemDir: env.systemDir,
        invocationKey: env.invocationKey,
        uiDesigns: { 'ui-export': { output: uiOutput(), invocationKey: invocation.invocationKey } },
      },
    );
    expect(record.status).toBe('accepted');
    expect(record.uiDesignCandidateKeys).toEqual(['ui-export']);
    expect(record.uiDesignInvocationKeys).toEqual({ 'ui-export': invocation.invocationKey });
    expect(env.store.db.issues[0]).toMatchObject({
      uiDesignInvocationKey: invocation.invocationKey,
      uiDesign: { candidateKey: 'ui-export', components: [{ id: 'export-action' }] },
    });
  });

  it.each([
    ['ambiguity', (output: ReturnType<typeof uiOutput>) => ({ ...output, ambiguities: ['Loading behavior is unspecified'] })],
    ['missing artifact', (output: ReturnType<typeof uiOutput>) => ({ ...output, artifact: null })],
    ['wrong candidate', (output: ReturnType<typeof uiOutput>) => ({ ...output, artifact: { ...output.artifact, candidateKey: 'other' } })],
    ['dangling design element', (output: ReturnType<typeof uiOutput>) => ({
      ...output,
      artifact: { ...output.artifact, criterionTraces: [{ criterionId: 'AC-UI-001', designElementIds: ['missing'] }] },
    })],
    ['missing criterion trace', (output: ReturnType<typeof uiOutput>) => ({ ...output, artifact: { ...output.artifact, criterionTraces: [] } })],
    ['duplicate element id', (output: ReturnType<typeof uiOutput>) => ({
      ...output,
      artifact: { ...output.artifact, components: [{ ...output.artifact.components[0]!, id: 'space-action' }] },
    })],
  ])('rejects an invalid UI design atomically: %s', (_name, mutate) => {
    const env = setup();
    const ui = { ...candidate('ui-export', 'AC-UI-001', 'export a report as CSV'), area: 'frontend' as const };
    const invocation = uiInvocation(env);
    const record = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, { candidates: [ui], ambiguities: [] },
      {
        systemDir: env.systemDir, invocationKey: env.invocationKey,
        uiDesigns: { 'ui-export': { output: mutate(uiOutput()), invocationKey: invocation.invocationKey } },
      },
    );
    expect(record.status).toBe('needs-human-review');
    expect(record.reasons.length).toBeGreaterThan(0);
    expect(env.store.db.issues).toEqual([]);
  });

  it('rejects failed UI provenance and an unexpected design for backend work', () => {
    const uiEnv = setup();
    const ui = { ...candidate('ui-export', 'AC-UI-001', 'export a report as CSV'), area: 'frontend' as const };
    const failed = uiInvocation(uiEnv, 'ui-export', 'failed');
    const failedRecord = applyPlanningEnrichment(
      uiEnv.store, uiEnv.config, uiEnv.intakeKey, { candidates: [ui], ambiguities: [] },
      {
        systemDir: uiEnv.systemDir, invocationKey: uiEnv.invocationKey,
        uiDesigns: { 'ui-export': { output: uiOutput(), invocationKey: failed.invocationKey } },
      },
    );
    expect(failedRecord.reasons.join('\n')).toContain('outcome must be completed');

    const backendEnv = setup();
    const backendInvocation = uiInvocation(backendEnv, 'api');
    const backendRecord = applyPlanningEnrichment(
      backendEnv.store, backendEnv.config, backendEnv.intakeKey,
      { candidates: [candidate('api', 'AC-API-001', 'export a report as CSV')], ambiguities: [] },
      {
        systemDir: backendEnv.systemDir, invocationKey: backendEnv.invocationKey,
        uiDesigns: { api: { output: uiOutput('api', 'AC-API-001'), invocationKey: backendInvocation.invocationKey } },
      },
    );
    expect(backendRecord.reasons.join('\n')).toContain('supplied for non-UI backend work');
    expect(backendEnv.store.db.issues).toEqual([]);
  });

  it('AC-UIDGATE-004/006 rejects a mixed batch atomically and reuses the first rejection', () => {
    const env = setup();
    const ui = { ...candidate('ui-export', 'AC-UI-001', 'export a report as CSV'), area: 'frontend' as const };
    const output = {
      candidates: [candidate('api-export', 'AC-API-001', 'export a report as CSV'), ui],
      ambiguities: [],
    };
    const first = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, output,
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const counters = { ...env.store.db.counters };
    const again = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, output,
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(first.status).toBe('needs-human-review');
    expect(env.store.db.issues).toEqual([]);
    expect(again).toEqual(first);
    expect(env.store.db.planningEnrichments).toHaveLength(1);
    expect(env.store.db.counters).toEqual(counters);
  });

  it('AC-ENRICH-001 creates 1..N contract-drafted, assigned Issues only after all candidates pass', () => {
    const env = setup();
    const record = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey,
      { candidates: [candidate('export-api', 'AC-CSV-001', 'export a report as CSV'), candidate('export-audit', 'AC-CSV-002', 'Users must export')], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );

    expect(record.status).toBe('accepted');
    expect(record.issueIds).toHaveLength(2);
    expect(env.store.db.issues.map((issue) => issue.status)).toEqual(['contract-drafted', 'contract-drafted']);
    expect(env.store.db.issues.map((issue) => issue.assignedAgent)).toEqual(['codex', 'codex']);
    expect(env.store.db.intakeRecords[0]!.status).toBe('ready');
    expect(env.store.db.intakeRecords[0]!.storeIssueIds).toEqual(record.issueIds);
  });

  it('AC-ENRICH-002 accepts exact source text and rejects text absent from the immutable snapshot', () => {
    const accepted = setup();
    expect(applyPlanningEnrichment(
      accepted.store, accepted.config, accepted.intakeKey,
      { candidates: [candidate('export', 'AC-CSV-001', 'Users must export a report as CSV')], ambiguities: [] },
      { systemDir: accepted.systemDir, invocationKey: accepted.invocationKey },
    ).status).toBe('accepted');

    const rejected = setup();
    const result = applyPlanningEnrichment(
      rejected.store, rejected.config, rejected.intakeKey,
      { candidates: [candidate('export', 'AC-CSV-001', 'Users requested PDF too')], ambiguities: [] },
      { systemDir: rejected.systemDir, invocationKey: rejected.invocationKey },
    );
    expect(result.status).toBe('needs-human-review');
    expect(result.reasons.join('\n')).toContain('source text not found');
    expect(rejected.store.db.issues).toEqual([]);
  });

  it('AC-ENRICH-003 resolves system traces into deduplicated Issue context', () => {
    const env = setup();
    const c = candidate('export', 'AC-CSV-001', 'export a report as CSV');
    c.traces[0]!.sources.push({ kind: 'system', elementId: 'DOM-test-001' } as never);
    const result = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, { candidates: [c], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(result.status).toBe('accepted');
    expect(env.store.db.issues[0]!.dependsOnSystem).toEqual(['DOM-test-001']);
  });

  it.each([
    ['ambiguity', (c: ReturnType<typeof candidate>) => ({ candidates: [c], ambiguities: ['CSV delimiter is unspecified'] })],
    ['duplicate AC id', (c: ReturnType<typeof candidate>) => ({ candidates: [{
      ...c,
      contract: { ...c.contract, acceptanceCriteria: [...c.contract.acceptanceCriteria, c.contract.acceptanceCriteria[0]!] },
    }], ambiguities: [] })],
    ['manual verification', (c: ReturnType<typeof candidate>) => ({ candidates: [{
      ...c,
      contract: {
        ...c.contract,
        acceptanceCriteria: [{ ...c.contract.acceptanceCriteria[0]!, verification: { method: 'manual', expected: ['human checks it'] } }],
      },
    }], ambiguities: [] })],
    ['missing AC trace', (c: ReturnType<typeof candidate>) => ({ candidates: [{ ...c, traces: [] }], ambiguities: [] })],
    ['extra AC trace', (c: ReturnType<typeof candidate>) => ({ candidates: [{ ...c, traces: [...c.traces, { criterionId: 'AC-OTHER-999', sources: [{ kind: 'source', text: 'export' }] }] }], ambiguities: [] })],
    ['dangling system id', (c: ReturnType<typeof candidate>) => ({ candidates: [{ ...c, traces: [{ criterionId: 'AC-CSV-001', sources: [{ kind: 'system', elementId: 'DOM-test-999' }] }] }], ambiguities: [] })],
  ])('AC-ENRICH-004 stops all issue creation for %s', (_name, mutate) => {
    const env = setup();
    const output = mutate(candidate('export', 'AC-CSV-001', 'export a report as CSV'));
    const beforeCounter = env.store.db.counters.ISSUE;
    const record = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey, output,
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(record.status).toBe('needs-human-review');
    expect(record.reasons.length).toBeGreaterThan(0);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.counters.ISSUE).toBe(beforeCounter);
    expect(env.store.db.intakeRecords[0]!.status).toBe('needs-human-review');
  });

  it('AC-ENRICH-005 preserves source→invocation→enrichment and Issue→candidate links', () => {
    const env = setup();
    const record = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey,
      { candidates: [candidate('export', 'AC-CSV-001', 'export a report as CSV')], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const issue = env.store.db.issues[0]!;
    expect(record.intakeKey).toBe(env.intakeKey);
    expect(record.invocationKey).toBe(env.invocationKey);
    expect(env.store.invocationByKey(record.invocationKey!)?.role).toBe('issue-planner');
    expect(issue.intakeKey).toBe(env.intakeKey);
    expect(issue.planningCandidateKey).toBe('export');
  });

  it('AC-ENRICH-006 returns the first decision on duplicate apply without growing records or counters', () => {
    const env = setup();
    const first = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey,
      { candidates: [candidate('export', 'AC-CSV-001', 'export a report as CSV')], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const counters = { ...env.store.db.counters };
    const again = applyPlanningEnrichment(
      env.store, env.config, env.intakeKey,
      { candidates: [candidate('different', 'AC-CSV-999', 'Users must export')], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(again).toEqual(first);
    expect(env.store.db.planningEnrichments).toHaveLength(1);
    expect(env.store.db.issues).toHaveLength(1);
    expect(env.store.db.counters).toEqual(counters);
  });
});
