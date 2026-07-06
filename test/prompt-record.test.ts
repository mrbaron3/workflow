/**
 * PromptRecord — the audit projection of a role session's issued prompt (DATA-execution-006).
 * Locks three things: the additive migration (an old DB with no promptRecords loads as []), the
 * lenient defaults (role/perspective/model/outcome), and the store round-trip (persist → reload →
 * query by issue). The generator's PROMPT.md is overwritten + wiped, so this is the only durable
 * copy — the test guards that it survives a save/reload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB, PromptRecord } from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prompt-'));
  dirs.push(root);
  return root;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const base = { id: 'PROMPT-0001', issueId: 'ISSUE-0001', prId: 'PR-0001', sampleIndex: 0, attempt: 1, agent: 'claude' as const, prompt: 'implement the contract', createdAt: nowISO() };

describe('PromptRecord schema', () => {
  it('defaults role to generator and the optional facets to null', () => {
    const r = PromptRecord.parse(base);
    expect(r.role).toBe('generator');
    expect(r.perspective).toBeNull();
    expect(r.model).toBeNull();
    expect(r.outcome).toBeNull();
  });

  it('keeps the model + outcome + repair attempt when supplied', () => {
    const r = PromptRecord.parse({ ...base, attempt: 2, model: 'haiku', outcome: 'stuck' });
    expect(r.attempt).toBe(2);
    expect(r.model).toBe('haiku');
    expect(r.outcome).toBe('stuck');
  });

  it('an old DB with no promptRecords loads as [] (additive migration)', () => {
    const legacy = DB.parse({ version: 1 }); // no promptRecords key
    expect(legacy.promptRecords).toEqual([]);
  });
});

describe('Store prompt records', () => {
  it('persists prompts and survives a save/reload, queryable by issue', () => {
    const root = tmpRoot();
    const store = new Store(root);
    store.addPromptRecord(PromptRecord.parse(base));
    store.addPromptRecord(PromptRecord.parse({ ...base, id: 'PROMPT-0002', attempt: 2, model: 'haiku', outcome: 'completed', prompt: 'apply the repair brief' }));
    store.addPromptRecord(PromptRecord.parse({ ...base, id: 'PROMPT-0003', issueId: 'ISSUE-0002' }));
    store.save();

    const reloaded = new Store(root); // fresh read from db.json
    const forIssue = reloaded.promptsForIssue('ISSUE-0001');
    expect(forIssue.map((r) => r.attempt)).toEqual([1, 2]); // insertion order, only this issue
    expect(forIssue[1]!.prompt).toBe('apply the repair brief'); // full text preserved, not overwritten
  });
});
