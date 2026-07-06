/**
 * Scoped-context assembler (ARCH-execution-007 / LANG-execution-006): resolve an issue's
 * dependsOnSystem ids to their defining lines from the system views — id references, never a
 * dumped design, and a dangling reference surfaced rather than dropped (DOM-execution-001).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Issue } from '../src/domain/schema.js';
import { resolveSystemContext, contextFor, renderScopedContext } from '../src/pipeline/execution/scoped-context.js';

function tmpSystemDir(name: string): string {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.md'), [
    '# Architecture',
    '',
    '- **ARCH-demo-001 orchestrator** — polls the queue and dispatches.',
    '- **ARCH-demo-002 worktree isolation** — one worktree per sample.',
    'Some prose that mentions ARCH-demo-001 mid-sentence but does not define it.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'domain-model.md'), [
    '# Domain',
    '- **DOM-demo-001 Execution Layer** — the layer boundary.',
  ].join('\n'));
  return dir;
}

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [{ id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } }],
  redLines: [],
};
const issueWith = (deps: string[]): Issue =>
  Issue.parse({ id: 'ISSUE-1', type: 'harness', title: 't', area: 'harness', status: 'contract-drafted', assignedAgent: 'mock', contract, dependsOnSystem: deps, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

describe('resolveSystemContext: ids -> defining lines', () => {
  it('resolves each id to its defining bullet, order-preserving and deduped', () => {
    const dir = tmpSystemDir('sc-resolve');
    const ctx = resolveSystemContext(['DOM-demo-001', 'ARCH-demo-002', 'DOM-demo-001'], dir);
    expect(ctx.resolved.map((e) => e.id)).toEqual(['DOM-demo-001', 'ARCH-demo-002']); // deduped, in request order
    expect(ctx.resolved[0]!.text).toContain('Execution Layer');
    expect(ctx.resolved[1]!.text).toContain('worktree isolation');
    expect(ctx.missing).toEqual([]);
  });

  it('matches only the DEFINING bullet, not mid-sentence mentions', () => {
    const dir = tmpSystemDir('sc-define');
    const ctx = resolveSystemContext(['ARCH-demo-001'], dir);
    expect(ctx.resolved[0]!.text).toContain('orchestrator'); // the bullet, not the prose line
    expect(ctx.resolved[0]!.text).not.toContain('mid-sentence');
  });

  it('surfaces a referenced id absent from the system views instead of dropping it', () => {
    const dir = tmpSystemDir('sc-missing');
    const ctx = resolveSystemContext(['ARCH-demo-001', 'ARCH-demo-999'], dir);
    expect(ctx.missing).toEqual(['ARCH-demo-999']);
    expect(ctx.resolved.find((e) => e.id === 'ARCH-demo-999')!.text).toBeNull();
  });

  it('ignores non-id strings (not counted as missing)', () => {
    const dir = tmpSystemDir('sc-nonid');
    const ctx = resolveSystemContext(['not-an-id', 'ARCH-demo-001'], dir);
    expect(ctx.resolved.map((e) => e.id)).toEqual(['ARCH-demo-001']);
    expect(ctx.missing).toEqual([]);
  });

  it('an unconfigured / missing systemDir resolves to nothing (no throw)', () => {
    const ctx = resolveSystemContext(['ARCH-demo-001'], path.join(os.tmpdir(), 'does-not-exist-xyz'));
    expect(ctx.missing).toEqual(['ARCH-demo-001']);
  });
});

describe('contextFor + renderScopedContext', () => {
  it('contextFor pulls exactly the issue dependsOnSystem', () => {
    const dir = tmpSystemDir('sc-issue');
    const ctx = contextFor(issueWith(['ARCH-demo-001', 'DOM-demo-001']), dir);
    expect(ctx.resolved.map((e) => e.id)).toEqual(['ARCH-demo-001', 'DOM-demo-001']);
  });

  it('renders a design section for resolved ids, empty string when nothing resolves', () => {
    const dir = tmpSystemDir('sc-render');
    expect(renderScopedContext(contextFor(issueWith([]), dir))).toBe(''); // no deps → no section
    const rendered = renderScopedContext(contextFor(issueWith(['ARCH-demo-001']), dir));
    expect(rendered).toContain('Referenced design');
    expect(rendered).toContain('orchestrator');
  });
});
