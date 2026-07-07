/**
 * The planning tree (計画の木): roadmap → epic → feature → spec spawn.
 *
 * This is the M21 wiring the roadmap-planner feeds into. It implements the
 * `docs/specs/planning-tree/` contract (AC-PLAN-001..009):
 *
 *   roadmap-planner (judgement) ─► planRoadmap (deterministic ingest)
 *                                     │  persists epics + features as the planning tree
 *                                     ▼
 *                                  spawnSpecs (deterministic materialize)
 *                                     │  one Feature = exactly one spec dir + tracked SpecState
 *                                     ▼
 *                                  to-spec authors the ACs, a human signs.
 *
 * The split is deliberate: the *quality* of a decomposition (which features, in
 * what order) is the planner's judgement and cannot be contracted — so this module
 * only enforces the mechanical invariants the spec pins down:
 *
 *   - the roadmap carries outcomes, never acceptance criteria (AC-PLAN-002/006);
 *   - one feature materializes into exactly one signable spec (AC-PLAN-003/004);
 *   - re-planning and re-spawning are additive & idempotent — a signed spec is
 *     never overwritten or deleted, descoping is a flag (AC-PLAN-005/007/009);
 *   - the chain north-star → epic → feature → spec → signed AC resolves both ways
 *     (AC-PLAN-008).
 *
 * The schema of the tree (Feature/Epic/Spec shapes, id formats) lives in
 * domain/schema.ts — the system-layer data-model — exactly as the spec's redline
 * demands; this module is process + gate behaviour only.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as YAML from 'yaml';
import { z } from 'zod';
import { Epic, Feature, Issue } from '../domain/schema.js';
import { lintDesign, type IssueCore } from '../design/lint.js';
import { Store, nowISO } from '../store/store.js';

// --- the roadmap-planner output contract (v2 — acceptance-criteria-free) -----

/**
 * What roadmap-planner emits: epics grouping features, where a feature carries a
 * title + outcome ("why now") and *no* acceptance criteria. AC are authored later
 * into the signed spec by to-spec. `id` is optional — supply it for stable,
 * human-readable ids; otherwise the store assigns one.
 *
 * `outcome` is intentionally optional in the shape so a missing/empty outcome
 * yields a precise, location-pointing error (AC-PLAN-002) rather than a generic
 * zod "Required".
 */
const PlannedFeature = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  outcome: z.string().optional(),
});

const PlannedEpic = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  theme: z.string().default(''),
  outcome: z.string().optional(),
  features: z.array(PlannedFeature).default([]),
});

export const PlannedRoadmap = z.object({
  vision: z.string(),
  principles: z.array(z.string()).default([]),
  epics: z.array(PlannedEpic).default([]),
});
export type PlannedRoadmap = z.infer<typeof PlannedRoadmap>;

/** Thrown when a roadmap violates a planning gate. `violations` lists the offenders. */
export class PlanIngestError extends Error {
  readonly violations: string[];
  constructor(message: string, violations: string[]) {
    super(message);
    this.name = 'PlanIngestError';
    this.violations = violations;
  }
}

// --- gate C: no acceptance criteria may ride in on the roadmap (AC-PLAN-006) --

/**
 * Keys that mean "someone inlined acceptance criteria / a finished issue contract"
 * into the roadmap. AC belong only in a signed spec; folding them into the plan
 * would break signing, drift detection and the source(spec)/derived(catalog)
 * split (DOC_LIFECYCLE). Compared case-insensitively.
 */
const FORBIDDEN_KEYS = new Set([
  'acceptancecriteria',
  'acceptance',
  'acceptancecriteriaids',
  'contract',
  'verification',
  'verifications',
  'criteria',
]);

/** Deep-walk the raw roadmap and return JSON-paths of any acceptance/contract keys. */
function findInlinedAcceptance(raw: unknown): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, p: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const kp = p ? `${p}.${k}` : k;
        if (FORBIDDEN_KEYS.has(k.toLowerCase())) hits.push(kp);
        walk(v, kp);
      }
    }
  };
  walk(raw, '');
  return hits;
}

// --- ingest (PLAN-A / PLAN-C / PLAN-D) ---------------------------------------

export interface PlanRoadmapOptions {
  /** Injectable clock for deterministic tests; defaults to wall-clock ISO. */
  now?: () => string;
}

export interface PlanRoadmapResult {
  epics: number; // epics in the tree after ingest
  features: number; // in-plan features in the tree after ingest
  added: { epics: number; features: number };
  descoped: string[]; // feature ids flagged out-of-plan this ingest (never deleted)
}

/**
 * Ingest a planner-authored roadmap into the planning tree. Pure validation runs
 * first and throws before any mutation, so a rejected roadmap leaves the tree
 * exactly as it was (AC-PLAN-002/006). Persistence is additive and matches
 * existing epics/features by stable natural key (explicit id, else title), so
 * re-ingesting the same roadmap is a structural no-op (NFR determinism / AC-PLAN-007).
 */
export function planRoadmap(
  store: Store,
  raw: unknown,
  opts: PlanRoadmapOptions = {},
): PlanRoadmapResult {
  const now = opts.now ?? nowISO;

  // Gate C (AC-PLAN-006): reject inlined acceptance criteria, persist nothing.
  const inlined = findInlinedAcceptance(raw);
  if (inlined.length) {
    throw new PlanIngestError(
      `roadmap must not carry acceptance criteria — those live only in a signed spec. Offending: ${inlined.join(', ')}`,
      inlined,
    );
  }

  const parsed = PlannedRoadmap.parse(raw);

  // Gate (AC-PLAN-002): every epic and feature must state an outcome ("why now").
  const missing: string[] = [];
  for (const e of parsed.epics) {
    if (!e.outcome || !e.outcome.trim()) missing.push(`epic "${e.title}"`);
    for (const f of e.features) {
      if (!f.outcome || !f.outcome.trim()) missing.push(`feature "${f.title}"`);
    }
  }
  if (missing.length) {
    throw new PlanIngestError(
      `No epic/feature without a stated outcome — missing on: ${missing.join(', ')}`,
      missing,
    );
  }

  // --- all gates passed; nothing above touched the store. Persist additively. ---

  if (!store.db.roadmap) {
    store.db.roadmap = { vision: parsed.vision, principles: parsed.principles, epicIds: [] };
  } else {
    store.db.roadmap.vision = parsed.vision;
    store.db.roadmap.principles = parsed.principles;
  }

  let addedEpics = 0;
  let addedFeatures = 0;
  const seen = new Set<string>();

  for (const ie of parsed.epics) {
    let epic = ie.id ? store.getEpic(ie.id) : store.db.epics.find((e) => e.title === ie.title);
    if (!epic) {
      const eid = ie.id ?? store.nextId('EPIC', 2);
      epic = Epic.parse({ id: eid, title: ie.title, theme: ie.theme, featureIds: [], issueIds: [] });
      store.addEpic(epic);
      addedEpics++;
    } else {
      if (epic.title !== ie.title) epic.title = ie.title;
      if (epic.theme !== ie.theme) epic.theme = ie.theme;
    }

    for (const ifeat of ie.features) {
      const outcome = ifeat.outcome!; // already gated non-empty above
      let feat = ifeat.id
        ? store.getFeature(ifeat.id)
        : store.db.features.find((f) => f.epicId === epic!.id && f.title === ifeat.title);
      if (!feat) {
        const fid = ifeat.id ?? store.nextId('FEAT', 3);
        feat = Feature.parse({
          id: fid,
          epicId: epic.id,
          title: ifeat.title,
          outcome,
          createdAt: now(),
          updatedAt: now(),
        });
        store.addFeature(feat);
        addedFeatures++;
      } else {
        let changed = false;
        if (feat.title !== ifeat.title) ((feat.title = ifeat.title), (changed = true));
        if (feat.outcome !== outcome) ((feat.outcome = outcome), (changed = true));
        if (feat.epicId !== epic.id) ((feat.epicId = epic.id), (changed = true));
        if (!feat.inPlan) ((feat.inPlan = true), (changed = true)); // re-scoped back in
        if (changed) feat.updatedAt = now();
        if (!epic.featureIds.includes(feat.id)) epic.featureIds.push(feat.id);
      }
      seen.add(feat.id);
    }
  }

  // Descope (AC-PLAN-009): an in-plan feature absent from this source is flagged,
  // never deleted — its (possibly signed) spec and history survive untouched.
  const descoped: string[] = [];
  for (const f of store.db.features) {
    if (f.inPlan && !seen.has(f.id)) {
      f.inPlan = false;
      f.updatedAt = now();
      descoped.push(f.id);
    }
  }

  return {
    epics: store.db.epics.length,
    features: store.db.features.filter((f) => f.inPlan).length,
    added: { epics: addedEpics, features: addedFeatures },
    descoped,
  };
}

// --- spawn (PLAN-B / PLAN-D) -------------------------------------------------

export interface SpawnSpecsOptions {
  /** Where spec dirs are created. Defaults to <root>/docs/specs. */
  specsRoot?: string;
  now?: () => string;
}

export interface SpawnSpecsResult {
  spawned: number;
  dirs: string[]; // repo-root-relative, posix
}

/**
 * Materialize each in-plan, not-yet-spawned feature into exactly one spec dir +
 * a tracked (unsigned) SpecState (AC-PLAN-003). Idempotent and non-destructive:
 * a feature with a specPath is skipped entirely, and files are written only when
 * absent, so authored or signed content is never overwritten (AC-PLAN-005).
 * Distinct features that slug to the same name get distinct dirs (AC-PLAN-004).
 */
export function spawnSpecs(store: Store, opts: SpawnSpecsOptions = {}): SpawnSpecsResult {
  const now = opts.now ?? nowISO;
  const specsRootAbs = opts.specsRoot ?? path.join(store.root, 'docs', 'specs');

  // Names already claimed: existing spec states + already-spawned features.
  const used = new Set<string>();
  for (const s of store.db.specStates) used.add(s.path);
  for (const f of store.db.features) if (f.specPath) used.add(f.specPath);

  const targets = store.db.features
    .filter((f) => f.inPlan && !f.specPath)
    .sort((a, b) => a.id.localeCompare(b.id)); // stable, deterministic order

  const dirs: string[] = [];
  for (const f of targets) {
    const rel = uniqueSpecDir(specsRootAbs, store.root, slugify(f.title) || f.id.toLowerCase(), used);
    used.add(rel);
    const abs = path.resolve(store.root, rel);
    fs.mkdirSync(abs, { recursive: true });

    const specFile = path.join(abs, 'spec.md');
    const accFile = path.join(abs, 'acceptance.yaml');
    if (!fs.existsSync(specFile)) fs.writeFileSync(specFile, stubSpec(f), 'utf8');
    if (!fs.existsSync(accFile)) fs.writeFileSync(accFile, stubAcceptance(f), 'utf8');

    const existing = store.getSpecState(rel);
    if (!existing) {
      store.upsertSpecState({
        path: rel,
        featureId: f.id,
        approved: null,
        signedAt: null,
        createdAt: now(),
        updatedAt: now(),
      });
    } else if (!existing.featureId) {
      existing.featureId = f.id; // adopt a pre-existing, unlinked spec
      existing.updatedAt = now();
    }

    f.specPath = rel;
    if (f.status === 'planned') f.status = 'specced';
    f.updatedAt = now();
    dirs.push(rel);
  }

  return { spawned: dirs.length, dirs };
}

/** Find a repo-relative spec dir under specsRoot that no one else has claimed (in db or on disk). */
function uniqueSpecDir(specsRootAbs: string, root: string, base: string, used: Set<string>): string {
  const relOf = (name: string): string =>
    path.relative(root, path.join(specsRootAbs, name)).split(path.sep).join('/');
  let name = base;
  let n = 1;
  while (used.has(relOf(name)) || fs.existsSync(path.join(specsRootAbs, name))) {
    n += 1;
    name = `${base}-${n}`;
  }
  return relOf(name);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * An authorable stub — intent only. It deliberately contains no `[AC-…]` line:
 * acceptance criteria are authored by to-spec and a human signs them (AC-PLAN-003).
 */
function stubSpec(f: Feature): string {
  return `# ${f.title} 受け入れ要件

> planning-tree が feature ${f.id} から生成した **著述 stub**。受け入れ基準はまだ無い。
> このファイルは人間が機能の WHAT（受け入れ基準）を著す source of truth。
> to-spec で Given/When/Then（安定 AC-ID）を著述し、人間が署名する。

## 意図（roadmap-planner が定めた outcome）

- 機能: ${f.title}
- outcome（価値・なぜ今）: ${f.outcome}
- 計画の木リンク: feature=${f.id}${f.epicId ? ` epic=${f.epicId}` : ''}

## 受け入れ基準

> ここに to-spec で AC を著述する（GWT・安定 AC-ID）。stub の時点では空。

## レッドライン

> 実装が絶対にしてはならないこと。to-spec / 設計で著述する。
`;
}

function stubAcceptance(f: Feature): string {
  return `# ${f.title} — 受け入れ検証 (stub)
#
# planning-tree が feature ${f.id} から生成。AC をまだ持たない。
# to-spec で spec.md に AC を著述したら、AC-ID をキーに verification(method + expected) を埋める。

verifications: {}
`;
}

// --- spawn issues (to-detail-design ingest: issues.yaml -> store ISSUE-NNNN) -

export interface SpawnIssuesOptions {
  /** Where the system layer lives (for dependsOnSystem existence). Defaults to <spec-dir>/../_system. */
  systemDir?: string;
  now?: () => string;
}

export interface SpawnIssuesResult {
  spawned: number;
  ids: string[]; // allocated store ISSUE-NNNN ids, in manifest order (empty when skipped)
}

/** One entry of a to-detail-design issues.yaml spawn manifest (validated against Issue at build). */
interface ManifestIssue {
  key: string; // draft-local handle; the store ISSUE-NNNN id is allocated here
  title: string;
  area: string;
  type?: string;
  coversAcIds?: string[];
  dependsOnIssues?: string[]; // predecessor *keys* in this manifest (remapped to ids on spawn)
  dependsOnSystem?: string[];
  implementationNotes?: string[];
  scope?: { include?: string[]; exclude?: string[] }; // file globs the drafted contract's scope_check enforces
}

const AC_RE = /\bAC-[A-Z0-9]+-\d+\b/g;
// Context-segmented system element ids: <KIND>-<ctx>-NNN (matches check-detail-design.ts).
const SYS_RE = /\b(?:LANG|DOM|ARCH|DATA|CONTRACT)-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/g;
const uniqStrs = (xs: string[]): string[] => [...new Set(xs)];

function readManifest(specAbs: string): ManifestIssue[] {
  const raw = YAML.parse(fs.readFileSync(path.join(specAbs, 'issues.yaml'), 'utf8')) as {
    issues?: ManifestIssue[];
  } | null;
  const issues = raw?.issues;
  if (!Array.isArray(issues)) throw new Error(`issues.yaml has no \`issues:\` list under ${specAbs}`);
  issues.forEach((m, i) => {
    if (!m || typeof m.key !== 'string') throw new Error(`issues[${i}] missing string \`key\``);
  });
  return issues;
}

function readSystemElementIds(systemDir: string): string[] {
  if (!fs.existsSync(systemDir)) return [];
  const ids: string[] = [];
  for (const rel of fs.readdirSync(systemDir, { recursive: true }) as string[]) {
    if (!rel.endsWith('.md')) continue;
    ids.push(...(fs.readFileSync(path.join(systemDir, rel), 'utf8').match(SYS_RE) ?? []));
  }
  return uniqStrs(ids);
}

const toIssueCore = (m: ManifestIssue): IssueCore => ({
  key: m.key,
  coversAcIds: m.coversAcIds ?? [],
  dependsOnIssues: m.dependsOnIssues ?? [],
  dependsOnSystem: m.dependsOnSystem ?? [],
});

/**
 * The pre-ingest policy gate — *the decision that shapes this feature*.
 *
 * Given the store, the spec's repo-relative path, and the authoritative design-lint
 * result, decide what spawnIssues does. There are three situations and each is a
 * genuine product choice, not a mechanical one:
 *
 *   1. The spec is NOT signed (no SpecState, or `approved` is null). Issues are a
 *      decomposition of a *signed* WHAT — spawning from an unsigned/abandoned spec
 *      breaks the north-star trace (north-star → feature → signed AC → issue). Should
 *      this be a hard error (loud — a human mis-sequenced the pipeline) or a quiet
 *      skip (tolerant — a batch run sweeps every spec and ignores the not-yet-ready)?
 *   2. The design lint FAILED (`!lint.ok`). "整合はコードが強制": the issue set must
 *      cover the AC set exactly. Almost certainly a hard error — but you decide, and
 *      decide what the message surfaces (lint.errors).
 *   3. The spec is ALREADY spawned (some store issue already has this specPath).
 *      Mirror spawnSpecs's idempotency: this is normal on re-run, so 'skip' (return
 *      {spawned:0}), never an error.
 *
 * Return 'proceed' to ingest, 'skip' to no-op. Throw for the hard-error cases so the
 * caller persists nothing.
 *
 * Policy (recommended default): a signed WHAT is a human judgement point (north-star:
 * 承認 stays human), so an unsigned/abandoned spec is a hard error — never spawn HOW
 * from an unconfirmed WHAT. A failed design lint is a hard error (整合はコードが強制),
 * surfacing the violations. An already-spawned spec is normal on re-run, so skip.
 */
function issueSpawnVerdict(
  store: Store,
  specPath: string,
  lint: { ok: boolean; errors: string[] },
): 'proceed' | 'skip' {
  if (store.db.issues.some((i) => i.specPath === specPath)) return 'skip'; // idempotent re-run
  const signed = store.getSpecState(specPath)?.approved != null;
  if (!signed) throw new Error(`spec is not signed: ${specPath} — issues decompose a signed WHAT (sign it first)`);
  if (!lint.ok) throw new Error(`issue set fails design lint for ${specPath}:\n  - ${lint.errors.join('\n  - ')}`);
  return 'proceed';
}

/**
 * Ingest a signed spec's to-detail-design output (issues.yaml) into the store: allocate
 * one ISSUE-NNNN per manifest entry, wire featureId/specPath/epicId from the planning
 * tree, and translate draft `dependsOnIssues` keys into the allocated ids. The
 * authoritative design lint runs first (整合はコードが強制); the eligibility policy is
 * `issueSpawnVerdict`. Idempotent: a spec whose issues already exist is skipped.
 */
export function spawnIssues(store: Store, specDir: string, opts: SpawnIssuesOptions = {}): SpawnIssuesResult {
  const now = opts.now ?? nowISO;
  const specAbs = path.resolve(store.root, specDir);
  const specPath = path.relative(store.root, specAbs).split(path.sep).join('/');

  const manifest = readManifest(specAbs);
  const specAcIds = uniqStrs(fs.readFileSync(path.join(specAbs, 'spec.md'), 'utf8').match(AC_RE) ?? []);
  const systemDir = opts.systemDir ? path.resolve(opts.systemDir) : path.resolve(specAbs, '..', '_system');
  const systemElementIds = readSystemElementIds(systemDir);

  const lint = lintDesign({ specAcIds, issues: manifest.map(toIssueCore), systemElementIds });

  if (issueSpawnVerdict(store, specPath, lint) === 'skip') return { spawned: 0, ids: [] };

  // Allocate every id up front so dependsOnIssues (forward-referencing draft keys) can be remapped.
  const keyToId = new Map<string, string>();
  for (const m of manifest) keyToId.set(m.key, store.nextId('ISSUE'));

  const featureId = store.getSpecState(specPath)?.featureId ?? null;
  const epicId = featureId ? (store.getFeature(featureId)?.epicId ?? null) : null;

  const ids: string[] = [];
  for (const m of manifest) {
    const id = keyToId.get(m.key)!;
    // Issue.parse validates area/type against the schema enums — a bad manifest throws here.
    const issue = Issue.parse({
      id,
      type: m.type ?? 'story',
      title: m.title,
      area: m.area,
      epicId,
      featureId,
      specPath,
      coversAcIds: m.coversAcIds ?? [],
      scope: m.scope ?? null,
      dependsOnSystem: m.dependsOnSystem ?? [],
      dependsOnIssues: (m.dependsOnIssues ?? []).map((k) => keyToId.get(k) ?? k),
      implementationNotes: m.implementationNotes ?? [],
      createdAt: now(),
      updatedAt: now(),
    });
    store.addIssue(issue); // wires the bidirectional Epic.issueIds link
    ids.push(id);
  }
  return { spawned: ids.length, ids };
}

// --- traceability (AC-PLAN-008) ----------------------------------------------

export interface FeatureTrace {
  featureId: string;
  epicId: string | null;
  roadmapVision: string | null;
  specPath: string | null;
  signed: boolean;
  approvedAcIds: string[];
  /** True iff every forward and reverse link in the chain resolves. */
  linked: boolean;
}

/**
 * Resolve the planning chain both ways for one feature:
 * north-star/roadmap → epic → feature → spec → signed AC, and back. Returns null
 * if the feature does not exist. `linked` is the AC-PLAN-008 reachability check.
 */
export function traceFeature(store: Store, featureId: string): FeatureTrace | null {
  const feature = store.getFeature(featureId);
  if (!feature) return null;
  const epic = feature.epicId ? store.getEpic(feature.epicId) : undefined;
  const roadmap = store.db.roadmap;
  const specState = feature.specPath ? store.getSpecState(feature.specPath) : undefined;
  const approvedAcIds = specState?.approved?.approvedAcIds ?? [];

  const linked =
    !!epic &&
    !!roadmap &&
    epic.featureIds.includes(feature.id) && // epic → feature
    roadmap.epicIds.includes(epic.id) && // roadmap → epic
    !!specState &&
    specState.featureId === feature.id && // spec → feature
    feature.specPath === specState.path; // feature → spec

  return {
    featureId: feature.id,
    epicId: feature.epicId,
    roadmapVision: roadmap?.vision ?? null,
    specPath: feature.specPath,
    signed: !!specState?.approved,
    approvedAcIds,
    linked,
  };
}

// --- file loader -------------------------------------------------------------

/** Parse a roadmap YAML file to a raw object — planRoadmap does the gating + validation. */
export function loadRoadmapFile(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}
