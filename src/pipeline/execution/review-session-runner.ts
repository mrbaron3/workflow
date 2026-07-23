import path from 'node:path';
import type { AgentProvider } from '../../domain/schema.js';
import { providerReadyPattern } from '../../agents/interactive-backend.js';
import type { AgentRoute } from '../../agents/routing.js';
import type { ReviewJob, ReviewStatus } from './perspective-session.js';
import { launchSession, sendPrompt, capturePane, killSession, monitorLiveness } from './tmux.js';
import { REVIEW_LIVENESS } from './review-liveness.js';

/** Run one read-only review session in its prepared worktree; returns its status (no git bookkeeping). */
export async function runReviewSession(
  issueKey: string,
  job: ReviewJob,
  log: (m: string) => void,
  route: AgentRoute,
): Promise<ReviewStatus> {
  const { provider } = route;
  const session = `ao-eval-${issueKey}-${job.key}`;
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
  await waitForReady(session, provider);
  const submitted = await sendPrompt(
    session,
    `Read the reviewer prompt at ${JSON.stringify(job.prompt)} and do exactly what it says.`,
  );
  if (!submitted) {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitForReady(
  session: string,
  provider: AgentProvider,
  timeoutMs = 20_000,
): Promise<void> {
  const ready = providerReadyPattern(provider);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready.test(capturePane(session))) return;
    await sleep(500);
  }
}
