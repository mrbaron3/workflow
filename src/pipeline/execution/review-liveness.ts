/**
 * Review-session liveness wiring (ISSUE-0007). Exported so the permanent guard
 * (test/acceptance-harness/active-liveness.acceptance.test.ts) can pin it: the released
 * panel's surviving major finding was that these were untested inline literals — a mutation
 * re-tightening the cap to 10 minutes (the exact ⑤ failure) survived every test.
 */
export const REVIEW_LIVENESS = { idleMs: 90_000, activeCapMs: 1000 * 60 * 60 * 2, pollMs: 3000 } as const;
