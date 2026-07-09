/**
 * Issue-scoped activation predicate (ISSUE-0022, AC-SCOPED-001/002/004) — the single
 * home for the acceptance-guard activation semantics and the env spelling (accept.ts,
 * the eval-task.ts precedent).
 *
 * The failure class (the D3 omnibus gap): suite-wide collection (ACCEPT_HARNESS=1)
 * activated EVERY pre-placed guard at once, so the first driven issue was gated on other
 * issues' baseline-red payloads. The predicate closes it: full activation keeps meaning
 * "all", scoped activation admits only the declared issue, and each guard declaration
 * resolves independently — never inferred from file or test names.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  acceptsIssue,
  scopedAcceptEnv,
  FULL_ACCEPT_ENV,
  SCOPED_ACCEPT_ENV,
} from '../src/pipeline/execution/accept.js';

describe('issue-scoped activation predicate (accept.ts)', () => {
  it('ISSUE-0022/AC-SCOPED-001 scoped activation admits only the declared issue', () => {
    const env = scopedAcceptEnv('ISSUE-A');
    expect(acceptsIssue('ISSUE-A', env)).toBe(true);
    expect(acceptsIssue('ISSUE-B', env)).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-001 no activation at all is off: absent and empty flags admit nothing', () => {
    expect(acceptsIssue('ISSUE-A', {})).toBe(false);
    expect(acceptsIssue('ISSUE-A', { [FULL_ACCEPT_ENV]: '' })).toBe(false);
    expect(acceptsIssue('ISSUE-A', { [SCOPED_ACCEPT_ENV]: '' })).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-001 the predicate defaults to process.env (guards call it bare)', () => {
    vi.stubEnv(FULL_ACCEPT_ENV, '');
    vi.stubEnv(SCOPED_ACCEPT_ENV, 'ISSUE-STUBBED');
    try {
      expect(acceptsIssue('ISSUE-STUBBED')).toBe(true);
      expect(acceptsIssue('ISSUE-OTHER')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ISSUE-0022/AC-SCOPED-002 activation resolves per declaration: two declarations sharing one env (one file) get independent answers', () => {
    // The 0019/0020 shared-file convention: one guard FILE hosts declarations for two
    // issues. Under an env scoped to ISSUE-A the two skipIf conditions evaluated in that
    // same file must diverge — file-level all-or-nothing cannot satisfy this.
    const env = scopedAcceptEnv('ISSUE-A');
    expect([acceptsIssue('ISSUE-A', env), acceptsIssue('ISSUE-B', env)]).toEqual([true, false]);
  });

  it('ISSUE-0022/AC-SCOPED-004 full activation keeps meaning ALL declared guards, whatever the scoped var says', () => {
    expect(acceptsIssue('ISSUE-A', { [FULL_ACCEPT_ENV]: '1' })).toBe(true);
    expect(acceptsIssue('ISSUE-B', { [FULL_ACCEPT_ENV]: '1' })).toBe(true);
    // full + scoped together: full wins — an explicit ACCEPT_HARNESS=1 spelling
    // (baseline-RED checks, captured regress commands) never narrows.
    expect(acceptsIssue('ISSUE-B', { [FULL_ACCEPT_ENV]: '1', ...scopedAcceptEnv('ISSUE-A') })).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 the env spelling is single-source and pinned (wiring convention)', () => {
    // The operational constants: the exact spellings grader commands and guard files share.
    expect(FULL_ACCEPT_ENV).toBe('ACCEPT_HARNESS');
    expect(SCOPED_ACCEPT_ENV).toBe('ACCEPT_HARNESS_ISSUE');
    // scopedAcceptEnv wires through the exported constant — no callsite re-encoding.
    expect(scopedAcceptEnv('ISSUE-X')).toEqual({ [SCOPED_ACCEPT_ENV]: 'ISSUE-X' });
  });
});
