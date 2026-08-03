import path from 'node:path';
import type { AgentRoute } from '../../agents/routing.js';
import type { ReviewJob, ReviewStatus } from './perspective-session.js';
import { launchSession, killSession, monitorLiveness } from './tmux.js';
import { REVIEW_LIVENESS } from './review-liveness.js';
import { submitPromptWhenSessionReady } from './session-readiness.js';
import { prepareRunnerDependencyMount } from './runner-sandbox.js';

/** Run one read-only review session in its prepared worktree; returns its status (no git bookkeeping). */
export async function runReviewSession(
  issueKey: string,
  job: ReviewJob,
  log: (m: string) => void,
  route: AgentRoute,
): Promise<ReviewStatus> {
  const { provider } = route;
  const session = `ao-eval-${issueKey}-${job.key}`;
  prepareRunnerDependencyMount(process.env, job.reviewWt);
  log(`  ▸ ${session}: read-only review`);
  // acceptEdits + Bash lets the review run tests and write ONLY its intended evidence without
  // approval stalls. The checkout is a disposable detached snapshot; prompt/findings live in an
  // explicitly added sidecar directory, and phase-3 rejects source/config changes fail-closed.
  launchSession({
    provider,
    purpose: 'reviewer',
    session,
    cwd: job.reviewWt,
    additionalDirs: [path.dirname(job.sentinel)],
    model: route.model ?? undefined,
  });
  const kickoff = await submitPromptWhenSessionReady(
    session,
    provider,
    `Read the reviewer prompt at ${JSON.stringify(job.prompt)} and do exactly what it says.`,
  );
  if (kickoff.readiness === 'timeout') {
    log(`  ⚠ ${session}: provider did not become ready — session + worktree kept alive`);
    return 'stuck';
  }
  if (!kickoff.submitted) {
    log(`  ⚠ ${session}: prompt may not have submitted — liveness monitor will surface it if stuck`);
  }
  // No per-review soft cap: a review still visibly working (⑤ ran 1h26m past the old 10-min
  // cap and its findings were lost) is kept alive up to the finite REVIEW_LIVENESS ceiling;
  // going idle on the way still surfaces as stuck via idleMs.
  const outcome = await monitorLiveness(session, job.sentinel, REVIEW_LIVENESS);

  if (outcome !== 'completed') {
    log(`  ⚠ ${session}: ${outcome} — session + worktree kept alive; inspect: tmux attach -t ${session}`);
    return outcome;
  }
  killSession(session);
  // The read-only guard (AC-PANEL-008) runs in collectFindings, at collection time, so a
  // late-collected stuck/timeout review passes the SAME dirty-checkout gate as a completed one.
  return 'completed';
}
