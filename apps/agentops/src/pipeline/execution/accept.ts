/**
 * Issue-scoped activation of pre-placed acceptance guards (ISSUE-0022) — the single home
 * for the activation semantics and the env spelling (the eval-task.ts precedent: one
 * module owns a convention every consumer shares).
 *
 * The failure class it closes (the D3 omnibus gap): suite-wide collection activated
 * EVERY pre-placed guard at once, so the first driven issue was gated on OTHER issues'
 * baseline-red payloads. Activation is now decidable per guard declaration:
 *
 *   - full activation — `ACCEPT_HARNESS=1` (truthy-nonempty; '' is OFF) keeps meaning
 *     ALL declared guards: baseline-RED checks and captured regress commands unchanged;
 *   - scoped activation — `scopedAcceptEnv(issueId)` (injected by groundArtifact into
 *     the grader child env) admits only guards DECLARED for the driven issue.
 *
 * Guard files gate per declaration, never per file, so two issues sharing one file
 * resolve independently (the 0019/0020 shared-file convention):
 *
 *   describe.skipIf(!acceptsIssue('ISSUE-XXXX'))('…', () => { … });
 *
 * The issue id is DECLARED in the guard source — activation is never inferred from file
 * or test names. Released guards are promoted by dropping the skipIf entirely; a
 * promoted guard never consults this module, so scoping only ever touches un-released
 * pre-placed guards.
 */

/** Full-activation env spelling: every declared guard collects. */
export const FULL_ACCEPT_ENV = 'ACCEPT_HARNESS';

/** Scoped-activation env spelling: only the named issue's declared guards collect. */
export const SCOPED_ACCEPT_ENV = 'ACCEPT_HARNESS_ISSUE';

/**
 * Does the current (or given) env activate guards declared for `issueId`? Full
 * activation admits every issue; scoped activation admits exactly the declared one;
 * neither set (or set empty) admits none.
 */
export function acceptsIssue(issueId: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env[FULL_ACCEPT_ENV]) return true;
  return env[SCOPED_ACCEPT_ENV] === issueId;
}

/** The env a grader child needs so exactly `issueId`'s declared guards activate. */
export function scopedAcceptEnv(issueId: string): Record<string, string> {
  return { [SCOPED_ACCEPT_ENV]: issueId };
}
