/**
 * The local store == the Eval Result DB == the source of truth.
 *
 * Everything is a single validated JSON document under .harness/db.json plus an
 * evidence tree under .harness/evidence/. Deliberately boring and inspectable:
 * you can `cat` the db, diff it, and the harness can resume from it after a crash.
 *
 * This is the seam where a GitHub adapter would later slot in — swap the read/save
 * of a JSON file for Issues/PRs/labels API calls and nothing upstream changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DB,
  PR as PRSchema,
  PrRevision as PrRevisionSchema,
  RevisionGateSnapshot as RevisionGateSnapshotSchema,
  emptyDB,
} from '../domain/schema.js';
import type {
  AgentInvocation,
  Epic,
  EvalRun,
  EvalTask,
  Feature,
  Intervention,
  IntakeRecord,
  Issue,
  PR,
  PrRevision,
  PromptRecord,
  RevisionGateSnapshot,
  PlanningEnrichmentRecord,
  RegressionRun,
  Roadmap,
  SpecState,
  TurnRecord,
} from '../domain/schema.js';
import { assertTransition, TERMINAL_STATUSES, type IssueStatus } from '../domain/states.js';

export function nowISO(): string {
  return new Date().toISOString();
}

export type StoreView = Omit<DB, 'prs' | 'prRevisions'> & {
  readonly prs: readonly PR[];
  readonly prRevisions: readonly PrRevision[];
};

/**
 * Normalize persisted records created before PR revisions became mandatory.
 * Legacy approvals cannot prove which head they approved, so migration fails
 * closed to `open`. Legacy gate reasons are retained as classified reasons.
 */
function normalizeLegacyDB(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  const normalizeRevisionCoordinates = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const row = value as Record<string, unknown>;
    const bound = typeof row.revisionId === 'string'
      && typeof row.headSha === 'string'
      && /^[0-9a-f]{40}$/i.test(row.headSha);
    if (bound) return value;
    return { ...row, revisionId: null, headSha: null };
  };
  return {
    ...record,
    ...(Array.isArray(record.prs) ? {
      prs: record.prs.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const pr = value as Record<string, unknown>;
        const bound = typeof pr.currentRevisionId === 'string'
          && typeof pr.headSha === 'string'
          && /^[0-9a-f]{40}$/i.test(pr.headSha);
        if (bound) return value;
        if (pr.status !== 'approved' && pr.status !== 'merged') {
          return {
            ...pr,
            currentRevisionId: null,
            headSha: null,
            mergedHeadSha: null,
          };
        }
        return {
          ...pr,
          status: 'open',
          currentRevisionId: null,
          headSha: null,
          mergedHeadSha: null,
        };
      }),
    } : {}),
    ...(Array.isArray(record.evalRuns) ? {
      evalRuns: record.evalRuns.map(normalizeRevisionCoordinates),
    } : {}),
    ...(Array.isArray(record.agentInvocations) ? {
      agentInvocations: record.agentInvocations.map(normalizeRevisionCoordinates),
    } : {}),
    ...(Array.isArray(record.revisionGateSnapshots) ? {
      revisionGateSnapshots: record.revisionGateSnapshots.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const snapshot = value as Record<string, unknown>;
        const reasons = Array.isArray(snapshot.reasons)
          ? snapshot.reasons.filter((reason): reason is string => typeof reason === 'string')
          : [];
        if (snapshot.decision === 'changes-requested') {
          return {
            ...snapshot,
            blockingReasons: Array.isArray(snapshot.blockingReasons)
              && snapshot.blockingReasons.length > 0
              ? snapshot.blockingReasons
              : reasons.length > 0
                ? reasons
                : ['legacy changes-requested snapshot'],
            pendingReasons: Array.isArray(snapshot.pendingReasons)
              ? snapshot.pendingReasons
              : [],
          };
        }
        if (snapshot.decision === 'pending') {
          return {
            ...snapshot,
            blockingReasons: [],
            pendingReasons: Array.isArray(snapshot.pendingReasons)
              ? snapshot.pendingReasons
              : reasons,
          };
        }
        return value;
      }),
    } : {}),
  };
}

export class Store {
  readonly root: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly evidenceRoot: string;
  /**
   * Public query view. PR lifecycle collections are readonly so callers cannot
   * bypass replacePR/replacePrRevision; other legacy collections retain their
   * existing mutable adapter surface until they receive dedicated repositories.
   */
  db: StoreView;

  constructor(root: string = process.cwd()) {
    this.root = root;
    this.dir = path.join(root, '.harness');
    this.dbPath = path.join(this.dir, 'db.json');
    this.evidenceRoot = path.join(this.dir, 'evidence');
    this.db = this.read();
  }

  static isInitialized(root: string = process.cwd()): boolean {
    return fs.existsSync(path.join(root, '.harness', 'db.json'));
  }

  read(): DB {
    if (!fs.existsSync(this.dbPath)) return emptyDB();
    const raw = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    return DB.parse(normalizeLegacyDB(raw)); // migrate known history, reject real corruption
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // Validate on the way out too, so we never persist something unloadable.
    const valid = DB.parse(this.db);
    fs.writeFileSync(this.dbPath, JSON.stringify(valid, null, 2) + '\n', 'utf8');
  }

  /** Sequential, human-readable ids: nextId('ISSUE') -> 'ISSUE-0001'. */
  nextId(prefix: string, pad = 4): string {
    const n = (this.db.counters[prefix] ?? 0) + 1;
    this.db.counters[prefix] = n;
    return `${prefix}-${String(n).padStart(pad, '0')}`;
  }

  // --- roadmap / epics -----------------------------------------------------

  setRoadmap(r: Roadmap): void {
    this.db.roadmap = r;
  }

  addEpic(e: Epic): Epic {
    this.db.epics.push(e);
    if (this.db.roadmap && !this.db.roadmap.epicIds.includes(e.id)) {
      this.db.roadmap.epicIds.push(e.id);
    }
    return e;
  }

  getEpic(id: string): Epic | undefined {
    return this.db.epics.find((e) => e.id === id);
  }

  // --- features (planning tree) --------------------------------------------

  /** Add a planning-tree feature and wire the bidirectional Epic.featureIds link. */
  addFeature(f: Feature): Feature {
    this.db.features.push(f);
    if (f.epicId) {
      const epic = this.getEpic(f.epicId);
      if (epic && !epic.featureIds.includes(f.id)) epic.featureIds.push(f.id);
    }
    return f;
  }

  getFeature(id: string): Feature | undefined {
    return this.db.features.find((f) => f.id === id);
  }

  // --- issues --------------------------------------------------------------

  addIssue(i: Issue): Issue {
    this.db.issues.push(i);
    if (i.epicId) {
      const epic = this.getEpic(i.epicId);
      if (epic && !epic.issueIds.includes(i.id)) epic.issueIds.push(i.id);
    }
    return i;
  }

  getIssue(id: string): Issue | undefined {
    return this.db.issues.find((i) => i.id === id);
  }

  requireIssue(id: string): Issue {
    const i = this.getIssue(id);
    if (!i) throw new Error(`No such issue: ${id}`);
    return i;
  }

  updateIssue(id: string, patch: Partial<Issue>): Issue {
    const i = this.requireIssue(id);
    Object.assign(i, patch, { updatedAt: nowISO() });
    return i;
  }

  /**
   * Move an issue to a new status, enforcing the state machine — except that a terminal
   * status is enterable from any NON-terminal status in one step. For `closed` this is the
   * rule itself: no TRANSITIONS edge enters it on purpose, so this carve-out is the decline
   * organ's only entrance (FEAT-005). For `released` it IS a loss of single-step strictness
   * (canTransition still forbids e.g. planned → released, but this method no longer rejects
   * it): every non-terminal status already reaches `released` legally in two steps via the
   * always-allowed `needs-human-review` escape hatch, and callers that mark history in
   * place (seeding a released issue where it stands, as the acceptance seam does) rely on
   * the direct jump. History stays immutable either way: nothing already terminal can be
   * re-terminalized here.
   */
  setStatus(id: string, to: IssueStatus): Issue {
    const i = this.requireIssue(id);
    const enteringTerminal = TERMINAL_STATUSES.has(to) && !TERMINAL_STATUSES.has(i.status);
    if (!enteringTerminal) assertTransition(i.status, to);
    i.status = to;
    i.updatedAt = nowISO();
    return i;
  }

  // --- PRs -----------------------------------------------------------------

  addPR(p: PR): PR {
    const stored = PRSchema.parse(structuredClone(p));
    (this.db.prs as DB['prs']).push(stored);
    return structuredClone(stored);
  }

  getPR(id: string): PR | undefined {
    const found = this.db.prs.find((p) => p.id === id);
    return found ? this.lifecycleCopy(found) : undefined;
  }

  prForIssue(issueId: string): PR | undefined {
    const found = this.db.prs.find((p) => p.issueId === issueId);
    return found ? this.lifecycleCopy(found) : undefined;
  }

  replacePR(p: PR): PR {
    const index = this.db.prs.findIndex((row) => row.id === p.id);
    if (index < 0) throw new Error(`No such PR: ${p.id}`);
    const existing = this.db.prs[index]!;
    const stored = PRSchema.parse(structuredClone(p));
    if (
      (existing.status === 'closed' || existing.status === 'merged')
      && !isDeepStrictEqual(existing, stored)
    ) {
      throw new Error(`cannot replace terminal PR ${existing.id} (${existing.status})`);
    }
    (this.db.prs as DB['prs'])[index] = stored;
    return this.lifecycleCopy(stored);
  }

  upsertPrRevision(revision: PrRevision): PrRevision {
    const existing = this.db.prRevisions.find(
      (row) => row.prId === revision.prId && row.headSha === revision.headSha,
    );
    if (existing) return this.lifecycleCopy(existing);
    const stored = PrRevisionSchema.parse(structuredClone(revision));
    (this.db.prRevisions as DB['prRevisions']).push(stored);
    return this.lifecycleCopy(stored);
  }

  revisionForHead(prId: string, headSha: string): PrRevision | undefined {
    const found = this.db.prRevisions.find((row) => row.prId === prId && row.headSha === headSha);
    return found ? this.lifecycleCopy(found) : undefined;
  }

  replacePrRevision(revision: PrRevision): PrRevision {
    const index = this.db.prRevisions.findIndex((row) => row.id === revision.id);
    if (index < 0) throw new Error(`No such PR revision: ${revision.id}`);
    const existing = this.db.prRevisions[index]!;
    const stored = PrRevisionSchema.parse(structuredClone(revision));
    if (
      (existing.status === 'merged' || existing.status === 'stale' || existing.status === 'failed')
      && !isDeepStrictEqual(existing, stored)
    ) {
      throw new Error(`cannot replace terminal PR revision ${existing.id} (${existing.status})`);
    }
    (this.db.prRevisions as DB['prRevisions'])[index] = stored;
    return this.lifecycleCopy(stored);
  }

  private lifecycleCopy<T>(value: T): T {
    const copy = structuredClone(value);
    const freeze = (item: unknown): void => {
      if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
      for (const nested of Object.values(item)) freeze(nested);
      Object.freeze(item);
    };
    freeze(copy);
    return copy;
  }

  addRevisionGateSnapshot(snapshot: RevisionGateSnapshot): RevisionGateSnapshot {
    const stored = RevisionGateSnapshotSchema.parse(structuredClone(snapshot));
    this.db.revisionGateSnapshots.push(stored);
    return this.lifecycleCopy(stored);
  }

  // --- spec states (M20 signing) -------------------------------------------

  getSpecState(specPath: string): SpecState | undefined {
    return this.db.specStates.find((s) => s.path === specPath);
  }

  /** Insert or replace the spec state for a path (identity = the spec dir path). */
  upsertSpecState(s: SpecState): SpecState {
    const i = this.db.specStates.findIndex((x) => x.path === s.path);
    if (i >= 0) this.db.specStates[i] = s;
    else this.db.specStates.push(s);
    return s;
  }

  // --- eval runs / tasks ---------------------------------------------------

  addEvalRun(r: EvalRun): EvalRun {
    this.db.evalRuns.push(r);
    return r;
  }

  runsForIssue(issueId: string): EvalRun[] {
    return this.db.evalRuns.filter((r) => r.issueId === issueId);
  }

  addEvalTask(t: EvalTask): EvalTask {
    this.db.evalTasks.push(t);
    return t;
  }

  getEvalTask(id: string): EvalTask | undefined {
    return this.db.evalTasks.find((t) => t.id === id);
  }

  /** Mirror of updateIssue: every task mutation goes through the Store (the adapter seam). */
  updateEvalTask(id: string, patch: Partial<EvalTask>): EvalTask {
    const t = this.getEvalTask(id);
    if (!t) throw new Error(`no such eval task: ${id}`);
    Object.assign(t, patch);
    return t;
  }

  // --- regression executions (③ re-verification of captured failures) ------

  addRegressionRun(r: RegressionRun): RegressionRun {
    this.db.regressionRuns.push(r);
    return r;
  }

  /** All executions of one eval task, in insertion (chronological) order. */
  regressionRunsForTask(taskId: string): RegressionRun[] {
    return this.db.regressionRuns.filter((r) => r.taskId === taskId);
  }

  // --- interventions (attested human HOW-involvement — autonomy axis) ------

  addIntervention(r: Intervention): Intervention {
    this.db.interventions.push(r);
    return r;
  }

  /** All attested interventions on one issue, in record order (per-issue audit). */
  interventionsForIssue(issueId: string): Intervention[] {
    return this.db.interventions.filter((r) => r.issueId === issueId);
  }

  // --- turn records (per-live-turn concurrency facts, AC-PAR-003) ----------

  addTurnRecord(r: TurnRecord): TurnRecord {
    this.db.turnRecords.push(r);
    return r;
  }

  /** The latest recorded live turn — the one the metrics instruments read. */
  lastTurnRecord(): TurnRecord | undefined {
    return this.db.turnRecords.at(-1);
  }

  // --- prompt records (audit trail of issued prompts) ----------------------

  /** Persist the exact prompt issued to a role session (DATA-execution-006). */
  addPromptRecord(r: PromptRecord): PromptRecord {
    this.db.promptRecords.push(r);
    return r;
  }

  /** All prompts issued for an issue, in insertion order (sample → attempt → role). */
  promptsForIssue(issueId: string): PromptRecord[] {
    return this.db.promptRecords.filter((r) => r.issueId === issueId);
  }

  // --- agent invocations (provider-neutral role-session provenance) -------

  invocationByKey(invocationKey: string): AgentInvocation | undefined {
    return this.db.agentInvocations.find((record) => record.invocationKey === invocationKey);
  }

  addAgentInvocation(record: AgentInvocation): AgentInvocation {
    this.db.agentInvocations.push(record);
    return record;
  }

  invocationsForIssue(issueId: string): AgentInvocation[] {
    return this.db.agentInvocations.filter((record) => record.issueId === issueId);
  }

  // --- external issue intake ---------------------------------------------

  intakeByKey(intakeKey: string): IntakeRecord | undefined {
    return this.db.intakeRecords.find((record) => record.intakeKey === intakeKey);
  }

  addIntakeRecord(record: IntakeRecord): IntakeRecord {
    this.db.intakeRecords.push(record);
    return record;
  }

  planningEnrichmentFor(intakeKey: string): PlanningEnrichmentRecord | undefined {
    return this.db.planningEnrichments.find((record) => record.intakeKey === intakeKey);
  }

  addPlanningEnrichment(record: PlanningEnrichmentRecord): PlanningEnrichmentRecord {
    this.db.planningEnrichments.push(record);
    return record;
  }

  /** Create (and return) the evidence directory for an eval run. */
  evidenceDir(evalRunId: string): string {
    const dir = path.join(this.evidenceRoot, evalRunId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Path of the evidence dir relative to the harness root (for storing in db). */
  evidenceRel(evalRunId: string): string {
    return path.relative(this.root, this.evidenceDir(evalRunId));
  }
}
