import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { planFromSeed, SeedRoadmap } from '../src/planning/planner.js';
import { runAll } from '../src/pipeline/coordinator.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const seed = SeedRoadmap.parse({
  vision: 'test product',
  principles: ['persist everything'],
  epics: [
    {
      id: 'EPIC-01',
      title: 'core',
      theme: 'core',
      issues: [
        {
          type: 'feature',
          area: 'frontend',
          title: 'A',
          contract: {
            productGoal: 'g',
            userStory: 'u',
            scope: { include: ['x'], exclude: ['y'] },
            acceptanceCriteria: [
              { id: 'AC-001', severity: 'blocker', behavior: 'b', verification: { method: 'playwright', expected: ['x'] } },
            ],
            redLines: [],
          },
        },
        {
          type: 'bug',
          area: 'backend',
          title: 'B',
          contract: {
            productGoal: 'g',
            userStory: 'u',
            scope: { include: ['x'], exclude: ['y'] },
            acceptanceCriteria: [
              { id: 'AC-001', severity: 'blocker', behavior: 'b', verification: { method: 'api_test', expected: ['x'] } },
            ],
            redLines: [],
          },
        },
      ],
    },
  ],
});

const cfg = { ...DEFAULT_CONFIG, samples: 3, maxRepairs: 2 };

describe('end-to-end pipeline (mock)', () => {
  it('plans, runs, and lands every issue in a terminal state with eval evidence', async () => {
    const store = tmpStore('pipe');
    const plan = planFromSeed(store, seed);
    expect(plan.issues).toBe(2);
    expect(store.db.issues.every((i) => i.status === 'contract-drafted')).toBe(true);

    const results = await runAll(store, cfg);
    expect(results).toHaveLength(2);

    for (const issue of store.db.issues) {
      expect(['released', 'needs-human-review']).toContain(issue.status);
    }
    expect(store.db.evalRuns.length).toBeGreaterThan(0);

    // every released issue has at least one approving run
    for (const issue of store.db.issues.filter((i) => i.status === 'released')) {
      const runs = store.runsForIssue(issue.id);
      expect(runs.some((r) => r.verdict === 'approve')).toBe(true);
    }

    // evidence is actually written to disk
    const someRun = store.db.evalRuns[0]!;
    const scorecard = path.join(store.root, someRun.evidenceDir!, 'scorecard.yaml');
    expect(fs.existsSync(scorecard)).toBe(true);
  });

  it('is deterministic: identical seed -> identical verdict sequence', async () => {
    const project = (store: Store) =>
      store.db.evalRuns
        .map((r) => `${r.issueId}|s${r.sampleIndex}|a${r.attempt}|${r.verdict}`)
        .sort();

    const a = tmpStore('det-a');
    planFromSeed(a, seed);
    await runAll(a, cfg);

    const b = tmpStore('det-b');
    planFromSeed(b, seed);
    await runAll(b, cfg);

    expect(project(a)).toEqual(project(b));
  });
});
