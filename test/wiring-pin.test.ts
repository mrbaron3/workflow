/**
 * Production-wiring pin convention (ISSUE-0021, AC-PIN-001..003) — the non-gated
 * regression net for the same seams the env-gated acceptance grader pins.
 *
 * The failure class: an operational constant wired as an inline literal at its callsite
 * lets a value-breaking mutation survive the whole suite. The convention closes it at
 * three points: the generator prompt (write side), the testQuality rubric (review side),
 * and the inventoried existing offenders exported as single-source pinned constants
 * (panel concurrency default; tmux submit retry wiring) with today's values exactly.
 */
import { describe, it, expect } from 'vitest';
import { buildGeneratorPrompt, type GeneratorSessionInput } from '../src/pipeline/execution/session.js';
import { perspectivePrompt } from '../src/pipeline/execution/perspective-session.js';
import { Issue, type IssueContract } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, resolvePanelMaxConcurrent, type TargetRepoConfig } from '../src/config.js';

// Missing-export erasure (⑥ precedent): both modules exist; the new exports are the red.
const configModule = (await import('../src/config.js')) as unknown as Record<string, unknown>;
const tmuxModule = (await import('../src/pipeline/execution/tmux.js')) as unknown as Record<string, unknown>;

const contract: IssueContract = {
  productGoal: 'g', userStory: 'u', scope: { include: ['src/**'], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

describe('production-wiring pin convention (AC-PIN-001..003)', () => {
  it('ISSUE-0021/AC-PIN-001 the generator prompt names the forbidden inline-literal shape and mandates exported, pin-tested constants', () => {
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
    // …with a pin test. The matcher must be satisfiable ONLY by the pin-test mandate itself:
    // a bare /pin/i was tautological (it matched 'skipping' in the role prompt), so deleting
    // the mandate from the wiring section stayed green.
    expect(prompt).toMatch(/test that pins its value/i);
  });

  it('ISSUE-0021/AC-PIN-002 the testQuality rubric hunts inline-constant wiring whose mutation would survive the suite', () => {
    const prompt = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality');
    expect(prompt).toMatch(/inline (literal|constant)/i);
    // Anchored to the inspection bullet itself — /mutation|mutant|survive/i was satisfied
    // by rubric boilerplate, so deleting the criterion stayed green (⑬ finding).
    expect(prompt).toMatch(/would survive the whole suite/i);
  });

  it('ISSUE-0021/AC-PIN-003 the inventoried constants are single-source exported pins with today\'s values (behavior unchanged)', () => {
    // (a) panel concurrency default: one source; the config default keeps its value.
    const panelDefault = configModule.DEFAULT_PANEL_MAX_CONCURRENT as number;
    expect(panelDefault).toBe(4);
    expect(DEFAULT_CONFIG.panel?.maxConcurrent).toBe(panelDefault);

    // (b) tmux submit retry wiring: exported, finite, today's values — including the
    // typed-text render wait, folded in from sendPrompt's last inline literal (400).
    const submit = tmuxModule.SUBMIT_RETRY as { attempts: number; settleMs: number; renderMs: number };
    expect(submit.attempts).toBe(4);
    expect(submit.settleMs).toBe(1500);
    expect(submit.renderMs).toBe(400);
    expect(Number.isFinite(submit.attempts)).toBe(true);
    expect(Number.isFinite(submit.settleMs)).toBe(true);
    expect(Number.isFinite(submit.renderMs)).toBe(true);
  });

  it('ISSUE-0021/AC-PIN-003 resolvePanelMaxConcurrent is the pinnable seam for the panel-cap fallback (no callsite re-encoding)', () => {
    // The fallback used to sit inline in runPerspectiveSessions, which is deliberately not
    // unit-tested (live tmux) — a re-inlined `?? 10` there survived the suite. The pure
    // resolver makes the wiring itself the thing under test, like resolveConcurrentIssueCap.
    const { panel: _panel, ...noPanel } = DEFAULT_CONFIG;
    expect(resolvePanelMaxConcurrent(noPanel)).toBe(configModule.DEFAULT_PANEL_MAX_CONCURRENT as number);
    expect(resolvePanelMaxConcurrent({ ...DEFAULT_CONFIG, panel: { maxConcurrent: 2 } })).toBe(2);
    expect(resolvePanelMaxConcurrent({ ...DEFAULT_CONFIG, panel: {} })).toBe(configModule.DEFAULT_PANEL_MAX_CONCURRENT as number);
  });
});
