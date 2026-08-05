/**
 * Bounded repair loop — grounds the 4 signed ACs of docs/specs/repair-loop.
 * A deterministic runner returns a failing build until a chosen attempt, then a clean one,
 * so convergence and exhaustion are both reproducible offline.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { driveIssueOnce } from '../src/pipeline/execution/loop.js';
import { aggregatePanelVerdict } from '../src/pipeline/panel.js';
import type { AgentRunner } from '../src/agents/runner.js';
import type { BuildArtifact, GenerateInput } from '../src/domain/artifact.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1, maxRepairs: 2 }; // 3 attempts max

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [{ id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } }],
  redLines: [],
};

function addIssue(store: Store, id: string): Issue {
  return store.addIssue(
    Issue.parse({
      id, type: 'harness', title: id, area: 'harness', status: 'contract-drafted', assignedAgent: 'mock',
      contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

/** Gates always pass; codeQuality is low (panel rejects) until `convergeAt`, then high (approves). */
function stagedRunner(convergeAt: number | null): { runner: AgentRunner; briefs: (GenerateInput['repairBrief'])[] } {
  const briefs: GenerateInput['repairBrief'][] = [];
  const runner: AgentRunner = {
    agent: 'mock',
    generate: async (input: GenerateInput): Promise<BuildArtifact> => {
      briefs.push(input.repairBrief ?? null);
      const good = convergeAt !== null && input.attempt >= convergeAt;
      const cq = good ? 0.9 : 0.3; // below passThreshold 0.7 => codeQuality perspective rejects
      return {
        branch: 'b', summary: 's', filesChanged: ['src/x.ts'], satisfied: { 'AC-1': true },
        buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true, hasTests: true,
        secretsLeaked: false, scopeViolations: [],
        quality: { codeQuality: cq, testQuality: 0.9, ux: 0.9, accessibility: 0.9 }, notes: [],
      };
    },
  };
  return { runner, briefs };
}

describe('AC-REPAIR-001: request_changes drives a re-implementation from the findings', () => {
  it('the second attempt receives a repair brief derived from the first attempt panel findings', async () => {
    const store = tmpStore('repair-001');
    const issue = addIssue(store, 'ISSUE-1');
    const { runner, briefs } = stagedRunner(2); // fail attempt 1, converge attempt 2

    await driveIssueOnce(store, CONFIG, runner, issue);

    expect(briefs[0]).toBeNull(); // attempt 1 = fresh
    expect(briefs[1]).not.toBeNull(); // attempt 2 = repair
    // the brief's findings come from the panel (the codeQuality rejection), not fabricated
    expect(briefs[1]!.findings.some((f) => f.criterionId.includes('codeQuality'))).toBe(true);
  });
});

describe('AC-REPAIR-002: converging within the bound advances to the gate', () => {
  it('stops repairing on approve and reaches needs-human-review, never auto-released', async () => {
    const store = tmpStore('repair-002');
    const issue = addIssue(store, 'ISSUE-1');
    const { runner } = stagedRunner(2);

    const res = await driveIssueOnce(store, CONFIG, runner, issue);

    expect(res.verdict).toBe('approve');
    expect(res.attempts).toBe(2); // converged on the 2nd, did not run the 3rd
    expect(res.status).toBe('needs-human-review'); // human gate
    expect(res.status).not.toBe('released');
  });
});

describe('AC-REPAIR-003: each attempt keeps independent evidence', () => {
  it('distinct attempts leave distinct EvalRun sets, so first-try vs eventual are separable', async () => {
    const store = tmpStore('repair-003');
    const issue = addIssue(store, 'ISSUE-1');
    const { runner } = stagedRunner(2);
    await driveIssueOnce(store, CONFIG, runner, issue);

    const runs = store.runsForIssue('ISSUE-1');
    const attempts = new Set(runs.map((r) => r.attempt));
    expect(attempts).toEqual(new Set([1, 2])); // one graded set per attempt
    // attempt 1 aggregate rejected, attempt 2 aggregate approved — the two are distinguishable
    expect(aggregatePanelVerdict(runs.filter((r) => r.attempt === 1))).toBe('request_changes');
    expect(aggregatePanelVerdict(runs.filter((r) => r.attempt === 2))).toBe('approve');
  });
});

describe('AC-REPAIR-004: the loop is bounded and escalates on exhaustion', () => {
  it('never-converging work stops at the cap and escalates to needs-human-review', async () => {
    const store = tmpStore('repair-004');
    const issue = addIssue(store, 'ISSUE-1');
    const { runner } = stagedRunner(null); // never converges

    const res = await driveIssueOnce(store, CONFIG, runner, issue);

    expect(res.attempts).toBe(CONFIG.maxRepairs + 1); // capped, no infinite loop
    expect(res.exhausted).toBe(true);
    expect(res.status).toBe('needs-human-review'); // escalated, not a silent pass/abandon
    expect(res.verdict).not.toBe('approve');
    // evidence for every attempt is retained
    expect(new Set(store.runsForIssue('ISSUE-1').map((r) => r.attempt)).size).toBe(CONFIG.maxRepairs + 1);
  });
});
