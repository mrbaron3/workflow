/**
 * The issue/work-unit state machine.
 *
 * In this harness, the *source of truth* for where a piece of work sits is its
 * status. On a real GitHub-backed deployment these map 1:1 to `status:*` labels
 * (see templates/labels.yaml). Locally they live on the Issue record in the store.
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
  'changes-requested',
  'approved',
  'ready-to-merge',
  'released',
  'needs-human-review',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statuses from which no automatic progress is possible. */
export const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(['released']);

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
  'evaluation-in-progress': ['changes-requested', 'approved'],
  // Repair loop: a changes-requested issue goes back to generation.
  'changes-requested': ['generation-in-progress'],
  approved: ['ready-to-merge'],
  'ready-to-merge': ['released'],
  released: [],
  // Human override can re-inject work at most sensible points.
  'needs-human-review': [
    'ready-for-contract',
    'ready-for-generation',
    'ready-for-evaluation',
    'changes-requested',
    'approved',
  ],
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
