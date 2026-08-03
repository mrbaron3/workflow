import { describe, expect, it } from 'vitest';
import { EnrichmentCandidate, IntakeRecord } from '../src/domain/schema.js';
import { buildUiDesignPrompt, UI_DESIGN_LIVENESS } from '../src/intake/ui-design-session.js';

describe('UI design session contract', () => {
  const intake = IntakeRecord.parse({
    id: 'INTAKE-1', intakeKey: 'github:acme%2Ftheme:42', provider: 'github', status: 'planning',
    snapshot: {
      repository: 'acme/theme', number: 42, externalId: 'I_42', title: 'Add export action',
      body: 'Users need a CSV export action.', url: 'https://example.test/42', labels: ['ready'], state: 'open',
      sourceUpdatedAt: '2026-07-14T00:00:00.000Z', snapshotAt: '2026-07-14T01:00:00.000Z',
    },
    claimedAt: '2026-07-14T01:00:01.000Z', createdAt: '2026-07-14T01:00:00.000Z', updatedAt: '2026-07-14T01:00:01.000Z',
  });
  const candidate = EnrichmentCandidate.parse({
    candidateKey: 'export-action', title: 'Add export action', type: 'feature', area: 'frontend',
    contract: {
      productGoal: 'Export CSV', userStory: 'As a user I export CSV', scope: { include: ['src/**'], exclude: [] },
      acceptanceCriteria: [{
        id: 'AC-UI-001', severity: 'blocker', behavior: 'The export action exposes progress',
        verification: { method: 'playwright', expected: ['idle/loading/error states are visible'] },
      }],
      redLines: [],
    },
    traces: [{ criterionId: 'AC-UI-001', sources: [{ kind: 'source', text: 'CSV export action' }] }],
  });

  it('scopes an independent read-only UI persona to the candidate and sidecar artifact', () => {
    const prompt = buildUiDesignPrompt(intake, candidate, '/evidence/ui-design.json', '/evidence/system');
    expect(prompt).toContain('You are the ui-designer');
    expect(prompt).toContain('fresh, dedicated context');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('/evidence/ui-design.json');
    expect(prompt).toContain('/evidence/system');
    expect(prompt).toContain('AC-UI-001');
    expect(prompt).toContain('criterionTraces');
    expect(prompt).toContain('accessibility');
    expect(prompt).toContain('artifact:null');
  });

  it('does not turn an unconfigured system view into a product ambiguity', () => {
    const prompt = buildUiDesignPrompt(intake, candidate, '/evidence/ui-design.json', null);
    expect(prompt).toContain('No system views are configured');
    expect(prompt).toContain('MUST NOT be reported as an ambiguity');
    expect(prompt).toContain('missing product decision');
    expect(prompt).not.toContain('/evidence/system');
  });

  it('keeps UI authoring liveness finite while allowing long active design analysis', () => {
    expect(Number.isFinite(UI_DESIGN_LIVENESS.activeCapMs)).toBe(true);
    expect(UI_DESIGN_LIVENESS.activeCapMs).toBeGreaterThanOrEqual(90 * 60 * 1000);
    expect(UI_DESIGN_LIVENESS.idleMs).toBeGreaterThan(0);
  });
});
