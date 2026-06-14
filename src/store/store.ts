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
import { DB, emptyDB } from '../domain/schema.js';
import type {
  Epic,
  EvalRun,
  EvalTask,
  Issue,
  PR,
  Roadmap,
} from '../domain/schema.js';
import { assertTransition, type IssueStatus } from '../domain/states.js';

export function nowISO(): string {
  return new Date().toISOString();
}

export class Store {
  readonly root: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly evidenceRoot: string;
  db: DB;

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
    return DB.parse(raw); // validate on load — a corrupt db fails loudly
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

  /** Move an issue to a new status, enforcing the state machine. */
  setStatus(id: string, to: IssueStatus): Issue {
    const i = this.requireIssue(id);
    assertTransition(i.status, to);
    i.status = to;
    i.updatedAt = nowISO();
    return i;
  }

  // --- PRs -----------------------------------------------------------------

  addPR(p: PR): PR {
    this.db.prs.push(p);
    return p;
  }

  getPR(id: string): PR | undefined {
    return this.db.prs.find((p) => p.id === id);
  }

  prForIssue(issueId: string): PR | undefined {
    return this.db.prs.find((p) => p.issueId === issueId);
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
