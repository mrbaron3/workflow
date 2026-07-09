/**
 * Env-gated acceptance grader for ISSUE-0021 "production-wiring pin convention" — spec
 * docs/specs/production-wiring-pin-convention (AC-PIN-001..003, FEAT-006 / EPIC-02 残).
 *
 * The failure class (⑥ major, generalised): an operational constant wired as an inline
 * literal lets a value-breaking mutation survive the whole suite. ⑥⑨⑩⑫'s conditional
 * approvals were ALL humans carrying this class of pin in at the gate — this issue closes
 * it at the source: the generator convention (write side), the testQuality rubric (review
 * side), and the inventoried existing offenders (panel cap default double-encoded at
 * config + callsite fallback; tmux submit retry literals).
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). After
 * the build is human-approved and released, the skipIf is dropped and this file stays in
 * protectedPaths as the permanent regression guard.
 *
 * Seams this file pins (⑥'s REVIEW_LIVENESS precedent — named exported constants):
 *   - config exports the panel-concurrency default as a single source (the callsite's
 *     `?? 4` duplicate encoding goes away);
 *   - tmux exports the submit retry wiring (attempts / settleMs) as a pinned constant;
 *   - defaults keep today's values exactly (behavior-preserving REFACTOR).
 */
import { describe, it, expect } from 'vitest';
import { buildGeneratorPrompt, type GeneratorSessionInput } from '../../src/pipeline/execution/session.js';
import { perspectivePrompt } from '../../src/pipeline/execution/perspective-session.js';
import { Issue, type IssueContract } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type TargetRepoConfig } from '../../src/config.js';

// Missing-export erasure (⑥ precedent): both modules exist; the new exports are the red.
const configModule = (await import('../../src/config.js')) as unknown as Record<string, unknown>;
const tmuxModule = (await import('../../src/pipeline/execution/tmux.js')) as unknown as Record<string, unknown>;

const contract: IssueContract = {
  productGoal: 'g', userStory: 'u', scope: { include: ['src/**'], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

describe.skipIf(!process.env.ACCEPT_HARNESS)('production-wiring pin convention (ISSUE-0021)', () => {
  it('ISSUE-0021/AC-PIN-001 the generator role prompt mandates exported-constant wiring with pin tests for operational constants', () => {
    const input: GeneratorSessionInput = {
      issue: Issue.parse({
        id: 'ISSUE-1', type: 'story', title: 't', area: 'backend', status: 'contract-drafted',
        assignedAgent: 'claude', contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      contract, sampleIndex: 0, attempt: 1, repairBrief: null,
    };
    const target: TargetRepoConfig = { repo: '.' };
    const prompt = buildGeneratorPrompt(input, target);
    expect(prompt).toMatch(/inline (literal|constant)/i); // the forbidden shape is named
    expect(prompt).toMatch(/export/i); // the required shape: an exported constant…
    expect(prompt).toMatch(/pin/i); // …with a test pinning its value/property
  });

  it('ISSUE-0021/AC-PIN-002 the testQuality rubric inspects for inline-constant wiring whose mutation survives the suite', () => {
    const prompt = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality');
    expect(prompt).toMatch(/inline (literal|constant)/i);
    expect(prompt).toMatch(/mutation|mutant|survive/i);
  });

  it('ISSUE-0021/AC-PIN-003 the inventoried constants are single-source exported pins with today\'s values (behavior unchanged)', () => {
    // (a) panel concurrency default: one source; the config default keeps its value.
    const panelDefault = configModule.DEFAULT_PANEL_MAX_CONCURRENT as number;
    expect(panelDefault).toBe(4);
    expect(DEFAULT_CONFIG.panel?.maxConcurrent).toBe(panelDefault); // config default derives from the single source

    // (b) tmux submit retry wiring: exported, finite, today's values.
    const submit = tmuxModule.SUBMIT_RETRY as { attempts: number; settleMs: number };
    expect(submit.attempts).toBe(4);
    expect(submit.settleMs).toBe(1500);
    expect(Number.isFinite(submit.attempts)).toBe(true);
    expect(Number.isFinite(submit.settleMs)).toBe(true);
  });
});
