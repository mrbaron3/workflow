/**
 * The issue/work-unit state machine.
 *
 * In this harness, the *source of truth* for where a piece of work sits is its
 * status. On a real GitHub-backed deployment these map 1:1 to `status:*` labels.
 * Locally they live on the Issue record in the store.
 *
 * The whole point of modelling this as an explicit machine (rather than free-text)
 * is that the Coordinator can resume, analyse and audit a run from state alone —
 * "tmux is running" is not a state; "issue 12 is in changes-requested" is.
 */

export const ISSUE_STATUSES = [
  'planned',
  'ready-for-contract',
  'contract-drafted',
  'ready-for-generation',
  'generation-in-progress',
  'ready-for-evaluation',
  'evaluation-in-progress',
  // The evaluator panel approved the build (LANG-evaluation-016). The legacy store
  // gate advances this to human review; the GitHub gate keeps it here while polling
  // automatically recoverable checks, draft state, and mergeability.
  'build-approved',
  'changes-requested',
  'approved',
  'ready-to-merge',
  'released',
  'needs-human-review',
  // Declined (FEAT-005): a human retired the issue with a reason (Issue.closedReason/At).
  // Terminal like `released`, but as a judgment ("not doing this") rather than history
  // ("this shipped") — which is why closing a released issue is forbidden while closing
  // any non-terminal one is allowed. The machine never enters it on its own: no TRANSITIONS
  // edge points here; only Store.setStatus's terminal-entry carve-out does.
  'closed',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statuses from which no automatic progress is possible. */
export const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(['released', 'closed']);

/**
 * Allowed forward transitions. `needs-human-review` is reachable from everywhere
 * (an escape hatch) and can be released back into the pipeline by a human.
 */
export const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  planned: ['ready-for-contract'],
  'ready-for-contract': ['contract-drafted'],
  'contract-drafted': ['ready-for-generation'],
  'ready-for-generation': ['generation-in-progress'],
  'generation-in-progress': ['ready-for-evaluation'],
  'ready-for-evaluation': ['evaluation-in-progress'],
  // Panel path adds build-approved; the legacy `approved` path is kept intact.
  'evaluation-in-progress': ['changes-requested', 'approved', 'build-approved'],
  // Store-gate approval stops at human review; GitHub-gate approval waits here.
  'build-approved': ['needs-human-review'],
  // Repair loop: a changes-requested issue goes back to generation.
  'changes-requested': ['generation-in-progress'],
  approved: ['ready-to-merge'],
  'ready-to-merge': ['released'],
  released: [],
  // Human override can re-inject work at most sensible points. `released` is reachable here
  // because the review gate releases a build-approved issue on human approval (DOM-execution-007).
  'needs-human-review': [
    'ready-for-contract',
    'ready-for-generation',
    'ready-for-evaluation',
    'changes-requested',
    'approved',
    'released',
  ],
  closed: [],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  if (to === 'needs-human-review') return true; // always allowed to escalate
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IssueStatus, to: IssueStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal status transition: ${from} -> ${to}. ` +
        `Allowed: ${TRANSITIONS[from].join(', ') || '(none)'} (+ needs-human-review).`,
    );
  }
}

// --- spec authoring status (M20) -------------------------------------------

/**
 * Spec signing status. Unlike IssueStatus this is NOT a writable state machine —
 * it is *derived* from whether a spec's signed approvedAcIds still cover its
 * current AC set (AC-AUTH-008; derivation lives in src/authoring/drift.ts).
 */
export const SPEC_STATUSES = ['approved', 'co-authoring'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];
