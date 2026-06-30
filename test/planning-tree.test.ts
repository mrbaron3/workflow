import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import {
  planRoadmap,
  spawnSpecs,
  spawnIssues,
  traceFeature,
  PlanIngestError,
} from '../src/planning/planning-tree.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `plan-tree-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const FIXED = () => '2026-01-01T00:00:00.000Z';

/** A valid v2 roadmap: epics → features, every node has an outcome, no AC anywhere. */
function roadmap(): unknown {
  return {
    vision: 'A task manager people trust.',
    principles: ['Persistence is non-negotiable.'],
    epics: [
      {
        id: 'EPIC-01',
        title: 'Core',
        theme: 'core',
        outcome: 'Users trust their tasks persist.',
        features: [
          { id: 'FEAT-001', title: 'Task CRUD with reload persistence', outcome: 'A task survives reload.' },
          { id: 'FEAT-002', title: 'Task filtering and search', outcome: 'Find tasks fast.' },
        ],
      },
      {
        id: 'EPIC-02',
        title: 'Onboarding',
        theme: 'growth',
        outcome: 'New users reach value first.',
        features: [{ id: 'FEAT-003', title: 'First-run sample data', outcome: 'No empty void on first run.' }],
      },
    ],
  };
}

/** Pin a fake human signature onto a spawned spec (real signing needs git). */
function fakeSign(store: Store, specPath: string, acIds: string[]): void {
  const st = store.getSpecState(specPath);
  if (!st) throw new Error(`no spec state at ${specPath}`);
  st.approved = {
    signedCommitSha: 'deadbeef',
    specBlobGitSha: 'aaaa',
    acceptanceBlobGitSha: 'bbbb',
    acFingerprints: Object.fromEntries(acIds.map((id) => [id, `fp-${id}`])),
    systemRefs: [],
    approvedAcIds: acIds,
  };
  st.signedAt = '2026-01-02T00:00:00.000Z';
  st.updatedAt = '2026-01-02T00:00:00.000Z';
}

// --- PLAN-A: ingest (AC-PLAN-001 / 002) --------------------------------------

describe('planRoadmap — ingest (PLAN-A)', () => {
  it('AC-PLAN-001: persists the decomposed roadmap as a planning tree, with no AC on features', () => {
    const store = tmpStore('ac001');
    const res = planRoadmap(store, roadmap());

    expect(res.epics).toBe(2);
    expect(res.features).toBe(3);
    expect(store.db.epics).toHaveLength(2);
    expect(store.db.features).toHaveLength(3);

    // each feature → exactly one epic; each epic → the roadmap; links are bidirectional.
    for (const f of store.db.features) {
      const epic = store.getEpic(f.epicId!);
      expect(epic).toBeDefined();
      expect(epic!.featureIds).toContain(f.id);
      expect(store.db.roadmap!.epicIds).toContain(epic!.id);
      // no acceptance criteria are stored on a feature — outcome only.
      expect(f.outcome.length).toBeGreaterThan(0);
      expect(Object.keys(f)).not.toContain('acceptanceCriteria');
    }
  });

  it('AC-PLAN-002: rejects a feature/epic with no outcome, leaving the tree untouched', () => {
    const store = tmpStore('ac002');
    const bad = roadmap() as any;
    bad.epics[0].features[0].outcome = '   '; // blank outcome

    expect(() => planRoadmap(store, bad)).toThrow(PlanIngestError);
    expect(() => planRoadmap(store, bad)).toThrow(/Task CRUD/); // points at the offender

    // nothing persisted.
    expect(store.db.roadmap).toBeNull();
    expect(store.db.epics).toHaveLength(0);
    expect(store.db.features).toHaveLength(0);
  });
});

// --- PLAN-C: alignment gate (AC-PLAN-006) ------------------------------------

describe('planRoadmap — acceptance-criteria gate (PLAN-C)', () => {
  it('AC-PLAN-006: rejects inlined acceptance criteria and persists nothing', () => {
    const store = tmpStore('ac006');
    const bad = roadmap() as any;
    bad.epics[0].features[0].acceptanceCriteria = [{ id: 'AC-001', behavior: 'x' }];

    expect(() => planRoadmap(store, bad)).toThrow(PlanIngestError);
    expect(() => planRoadmap(store, bad)).toThrow(/acceptanceCriteria/);
    expect(store.db.roadmap).toBeNull();
    expect(store.db.epics).toHaveLength(0);
    expect(store.db.features).toHaveLength(0);
  });

  it('AC-PLAN-006: also rejects a legacy issue contract nested under the roadmap', () => {
    const store = tmpStore('ac006b');
    const legacy = {
      vision: 'v',
      epics: [{ title: 'E', outcome: 'o', issues: [{ contract: { acceptanceCriteria: [] } }] }],
    };
    expect(() => planRoadmap(store, legacy)).toThrow(/contract/);
    expect(store.db.features).toHaveLength(0);
  });
});

// --- PLAN-B: spawn (AC-PLAN-003 / 004 / 005) ---------------------------------

describe('spawnSpecs — materialize (PLAN-B)', () => {
  it('AC-PLAN-003: every feature gets exactly one tracked, unsigned, AC-free spec stub', () => {
    const store = tmpStore('ac003');
    planRoadmap(store, roadmap());
    const res = spawnSpecs(store);

    expect(res.spawned).toBe(3);
    expect(res.dirs).toHaveLength(3);
    expect(store.db.specStates).toHaveLength(3);

    for (const f of store.db.features) {
      expect(f.specPath).not.toBeNull();
      expect(f.status).toBe('specced');
      const st = store.getSpecState(f.specPath!)!;
      expect(st.featureId).toBe(f.id); // bidirectional link
      expect(st.approved).toBeNull(); // unsigned
      const specMd = fs.readFileSync(path.resolve(store.root, f.specPath!, 'spec.md'), 'utf8');
      expect(specMd).not.toMatch(/\[AC-/); // a stub carries no acceptance criteria
      expect(fs.existsSync(path.resolve(store.root, f.specPath!, 'acceptance.yaml'))).toBe(true);
    }
  });

  it('AC-PLAN-004: two features with the same title get distinct, exclusive spec dirs', () => {
    const store = tmpStore('ac004');
    planRoadmap(store, {
      vision: 'v',
      epics: [
        {
          id: 'EPIC-01',
          title: 'E',
          theme: 't',
          outcome: 'o',
          features: [
            { id: 'FEAT-001', title: 'Same Title', outcome: 'a' },
            { id: 'FEAT-002', title: 'Same Title', outcome: 'b' },
          ],
        },
      ],
    });
    spawnSpecs(store);

    const paths = store.db.features.map((f) => f.specPath);
    expect(new Set(paths).size).toBe(2); // distinct dirs, no collision

    // each spec state maps to exactly one feature (no spec shared by two features).
    const featureIds = store.db.specStates.map((s) => s.featureId);
    expect(new Set(featureIds).size).toBe(2);
    for (const st of store.db.specStates) {
      const owners = store.db.features.filter((f) => f.specPath === st.path);
      expect(owners).toHaveLength(1);
    }
  });

  it('AC-PLAN-005: re-spawn is idempotent and never overwrites authored content', () => {
    const store = tmpStore('ac005');
    planRoadmap(store, roadmap());
    spawnSpecs(store);

    const feature = store.db.features[0]!;
    const specFile = path.resolve(store.root, feature.specPath!, 'spec.md');
    const authored = fs.readFileSync(specFile, 'utf8') + '\n\n## Authored by to-spec\n- **[AC-FOO-001] x**\n';
    fs.writeFileSync(specFile, authored, 'utf8');

    const res2 = spawnSpecs(store);
    expect(res2.spawned).toBe(0); // nothing new
    expect(store.db.specStates).toHaveLength(3); // no duplicate states
    expect(fs.readFileSync(specFile, 'utf8')).toBe(authored); // content preserved
  });
});

// --- PLAN-D: idempotent re-plan + traceability (AC-PLAN-007 / 008 / 009) ------

describe('planRoadmap — re-plan & traceability (PLAN-D)', () => {
  it('AC-PLAN-007: re-ingest is additive and does not disturb a signed spec', () => {
    const store = tmpStore('ac007');
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    const signed = store.getFeature('FEAT-001')!;
    fakeSign(store, signed.specPath!, ['AC-FEAT-001-001']);
    const before = JSON.stringify(store.getSpecState(signed.specPath!));
    const featureCountBefore = store.db.features.length;

    // re-ingest the same roadmap plus one extra feature.
    const extended = roadmap() as any;
    extended.epics[1].features.push({ id: 'FEAT-009', title: 'Keyboard access', outcome: 'No mouse needed.' });
    const res = planRoadmap(store, extended);

    expect(store.db.features.length).toBe(featureCountBefore + 1); // exactly one added
    expect(res.added.features).toBe(1);
    expect(JSON.stringify(store.getSpecState(signed.specPath!))).toBe(before); // signature untouched
  });

  it('AC-PLAN-008: the chain resolves both ways for a signed feature', () => {
    const store = tmpStore('ac008');
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    const f = store.getFeature('FEAT-001')!;
    fakeSign(store, f.specPath!, ['AC-FEAT-001-001', 'AC-FEAT-001-002']);

    const t = traceFeature(store, 'FEAT-001')!;
    expect(t.linked).toBe(true);
    expect(t.signed).toBe(true);
    expect(t.approvedAcIds).toEqual(['AC-FEAT-001-001', 'AC-FEAT-001-002']);
    expect(t.epicId).toBe('EPIC-01');
    expect(t.roadmapVision).toBe('A task manager people trust.');

    // reverse links resolve through the store graph too.
    expect(store.getEpic('EPIC-01')!.featureIds).toContain('FEAT-001');
    expect(store.db.roadmap!.epicIds).toContain('EPIC-01');
    expect(store.getSpecState(f.specPath!)!.featureId).toBe('FEAT-001');
  });

  it('AC-PLAN-009: descoping a feature flags it without deleting its signed spec', () => {
    const store = tmpStore('ac009');
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    const f = store.getFeature('FEAT-003')!; // the lone EPIC-02 feature
    fakeSign(store, f.specPath!, ['AC-FEAT-003-001']);
    const specDir = path.resolve(store.root, f.specPath!);

    // re-ingest with FEAT-003 removed from the source.
    const trimmed = roadmap() as any;
    trimmed.epics[1].features = [];
    const res = planRoadmap(store, trimmed);

    expect(res.descoped).toContain('FEAT-003');
    const after = store.getFeature('FEAT-003')!;
    expect(after).toBeDefined(); // not physically deleted
    expect(after.inPlan).toBe(false); // just flagged
    expect(after.specPath).toBe(f.specPath); // spec link preserved
    expect(fs.existsSync(path.join(specDir, 'spec.md'))).toBe(true); // dir survives
    expect(store.getSpecState(f.specPath!)!.approved).not.toBeNull(); // signature survives
  });
});

// --- spawn issues: to-detail-design ingest (issues.yaml -> store ISSUE-NNNN) --

/**
 * Author AC anchors into a feature's spawned spec, optionally seed a _system element,
 * sign it, and drop an issues.yaml manifest beside it. Returns the spec dir (relative).
 */
function authorSignedSpec(
  store: Store,
  featureId: string,
  acIds: string[],
  manifestYaml: string,
  opts: { sign?: boolean; systemElementId?: string } = {},
): string {
  const f = store.getFeature(featureId)!;
  const specAbs = path.resolve(store.root, f.specPath!);
  const acLines = acIds.map((id) => `- **[${id}]** the behavior for ${id}`).join('\n');
  fs.writeFileSync(path.join(specAbs, 'spec.md'), `# Spec\n\n## 受け入れ基準\n${acLines}\n`, 'utf8');
  if (opts.sign !== false) fakeSign(store, f.specPath!, acIds);
  if (opts.systemElementId) {
    const sysDir = path.resolve(specAbs, '..', '_system', 'todo');
    fs.mkdirSync(sysDir, { recursive: true });
    fs.writeFileSync(path.join(sysDir, 'data-model.md'), `# data\n- ${opts.systemElementId}\n`, 'utf8');
  }
  fs.writeFileSync(path.join(specAbs, 'issues.yaml'), manifestYaml, 'utf8');
  return f.specPath!;
}

describe('spawnIssues — ingest a signed spec into the store', () => {
  const MANIFEST = `issues:
  - key: ISSUE-TODO-001
    title: Persist the todo store
    area: backend
    coversAcIds: [AC-TODO-001]
    dependsOnSystem: [DATA-todo-001]
  - key: ISSUE-TODO-002
    title: Build the todo list UI
    area: frontend
    coversAcIds: [AC-TODO-002]
    dependsOnIssues: [ISSUE-TODO-001]
`;

  function setup(name: string): { store: Store; specPath: string } {
    const store = tmpStore(name);
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    const specPath = authorSignedSpec(store, 'FEAT-001', ['AC-TODO-001', 'AC-TODO-002'], MANIFEST, {
      systemElementId: 'DATA-todo-001',
    });
    return { store, specPath };
  }

  it('allocates one ISSUE-NNNN per entry, wired to feature/spec/epic, with keys remapped to ids', () => {
    const { store, specPath } = setup('spawn-ok');
    const res = spawnIssues(store, specPath, { now: FIXED });

    expect(res.spawned).toBe(2);
    expect(res.ids).toEqual(['ISSUE-0001', 'ISSUE-0002']);
    expect(store.db.issues).toHaveLength(2);

    const a = store.db.issues[0]!;
    const b = store.db.issues[1]!;
    // planning-tree links: every issue descends from the signed feature/spec/epic.
    expect(a.featureId).toBe('FEAT-001');
    expect(a.specPath).toBe(specPath);
    expect(a.epicId).toBe('EPIC-01');
    expect(a.coversAcIds).toEqual(['AC-TODO-001']);
    expect(a.dependsOnSystem).toEqual(['DATA-todo-001']);
    // the draft key in dependsOnIssues is remapped to the allocated store id.
    expect(b.dependsOnIssues).toEqual(['ISSUE-0001']);
    expect(b.area).toBe('frontend');
    expect(b.type).toBe('story'); // defaulted

    // the bidirectional Epic.issueIds link is wired by addIssue.
    expect(store.getEpic('EPIC-01')!.issueIds).toEqual(['ISSUE-0001', 'ISSUE-0002']);
  });

  it('refuses an unsigned spec and persists nothing (北極星: 承認 is a human judgement point)', () => {
    const store = tmpStore('spawn-unsigned');
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    const specPath = authorSignedSpec(store, 'FEAT-001', ['AC-TODO-001', 'AC-TODO-002'], MANIFEST, {
      sign: false,
      systemElementId: 'DATA-todo-001',
    });

    expect(() => spawnIssues(store, specPath)).toThrow(/not signed/);
    expect(store.db.issues).toHaveLength(0);
  });

  it('refuses an issue set that fails coverage×exclusivity and persists nothing', () => {
    const store = tmpStore('spawn-coverage');
    planRoadmap(store, roadmap());
    spawnSpecs(store);
    // manifest covers only AC-TODO-001; AC-TODO-002 is left uncovered.
    const partial = `issues:
  - key: ISSUE-TODO-001
    title: Only half the spec
    area: backend
    coversAcIds: [AC-TODO-001]
`;
    const specPath = authorSignedSpec(store, 'FEAT-001', ['AC-TODO-001', 'AC-TODO-002'], partial);

    expect(() => spawnIssues(store, specPath)).toThrow(/design lint/);
    expect(() => spawnIssues(store, specPath)).toThrow(/AC-TODO-002/); // names the uncovered AC
    expect(store.db.issues).toHaveLength(0);
  });

  it('is idempotent: re-spawning an already-decomposed spec is a no-op', () => {
    const { store, specPath } = setup('spawn-idempotent');
    spawnIssues(store, specPath, { now: FIXED });
    const res2 = spawnIssues(store, specPath, { now: FIXED });

    expect(res2.spawned).toBe(0);
    expect(res2.ids).toEqual([]);
    expect(store.db.issues).toHaveLength(2); // no duplicates
  });
});

// --- NFR: determinism --------------------------------------------------------

describe('planning tree — determinism (NFR)', () => {
  it('the same roadmap yields the same tree (no diff on re-ingest)', () => {
    const a = tmpStore('det-a');
    const b = tmpStore('det-b');
    planRoadmap(a, roadmap(), { now: FIXED });
    planRoadmap(b, roadmap(), { now: FIXED });
    expect(a.db.features).toEqual(b.db.features);
    expect(a.db.epics).toEqual(b.db.epics);

    // re-ingesting the identical roadmap is a structural no-op.
    const snapshot = JSON.stringify({ epics: a.db.epics, features: a.db.features, roadmap: a.db.roadmap });
    planRoadmap(a, roadmap(), { now: FIXED });
    expect(JSON.stringify({ epics: a.db.epics, features: a.db.features, roadmap: a.db.roadmap })).toBe(snapshot);
  });

  it('spawn produces the same dirs for the same tree', () => {
    const a = tmpStore('det-spawn-a');
    const b = tmpStore('det-spawn-b');
    planRoadmap(a, roadmap(), { now: FIXED });
    planRoadmap(b, roadmap(), { now: FIXED });
    const da = spawnSpecs(a, { now: FIXED }).dirs.map((d) => d.split('/').pop());
    const db = spawnSpecs(b, { now: FIXED }).dirs.map((d) => d.split('/').pop());
    expect(da).toEqual(db);
  });
});
