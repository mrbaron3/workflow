/**
 * Low-level tmux session substrate (ARCH-execution-003, realising DOM-execution-002/005).
 *
 * A role runs as an INTERACTIVE, attachable Claude Code session inside its own tmux WINDOW (tab) —
 * not `claude -p` headless (North Star: headless is a non-goal; a human can `tmux attach` to
 * review/intervene). All role windows live under ONE holder session (WINDOW_HOLDER) so a single
 * `tmux attach -t agentops` shows every generator/reviewer as a tab. The launch recipe was
 * validated by a live smoke test: no trust prompt in a fresh dir, `acceptEdits` writes files
 * without per-edit prompts, `send-keys -l` drives the input, and the agent hands control back by
 * writing a sentinel.
 *
 * These are thin wrappers over the `tmux` CLI; all orchestration decisions (when to launch,
 * when to grade) live in deterministic code above this seam (ARCH-execution-011).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  buildInteractiveLaunchCommand,
  type InteractiveLaunchRequest,
} from '../../agents/interactive-backend.js';

export interface LaunchOpts extends InteractiveLaunchRequest {
  cols?: number;
  rows?: number;
}

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('tmux', args, { encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Every role session runs as a WINDOW (tab) of ONE holder tmux session, so a human can watch all
 * the generator/reviewer sessions at once with a single `tmux attach -t <holder>` instead of
 * hunting for N separate detached sessions. Overridable via env (a pre-existing session of this
 * name is reused). A finished session's tab is closed (killSession → kill-window); a stuck one is
 * kept (ARCH-execution-014) so a human can attach to that exact tab and take over.
 */
export const WINDOW_HOLDER = process.env.AGENTOPS_TMUX_SESSION || 'agentops';

/** tmux target for a role session's window: `<holder>:<session>` (the session id IS the window name). */
function target(session: string): string {
  return `${WINDOW_HOLDER}:${session}`;
}

/**
 * Ensure the holder session exists (detached), carrying a persistent idle "home" tab so it survives
 * while individual role tabs open and close — without the home window, closing the only role tab
 * would kill the holder and race the next launch. Idempotent: reuses an existing holder.
 */
function ensureHolder(cols: number, rows: number): void {
  if (tmux(['has-session', '-t', WINDOW_HOLDER]).ok) return;
  const home =
    "printf '%s\\n' 'agentops dashboard — generator/reviewer sessions open here as tabs; a finished tab closes.'; " +
    'while true; do sleep 3600; done';
  const r = tmux(['new-session', '-d', '-s', WINDOW_HOLDER, '-n', 'home', '-x', String(cols), '-y', String(rows), home]);
  if (!r.ok) throw new Error(`tmux new-session (holder) failed: ${r.stderr || r.stdout}`);
  // pin our -n window names (tmux would otherwise auto-rename each window to its running command,
  // which would both mislabel the tabs and break name-based targeting below)
  tmux(['set-option', '-t', WINDOW_HOLDER, 'automatic-rename', 'off']);
  tmux(['set-option', '-t', WINDOW_HOLDER, 'allow-rename', 'off']);
}

/**
 * Build the `claude` command line the tmux window runs. Pure + exported so the flag wiring
 * (allowedTools, permission mode, optional `--model`) is unit-testable without spawning tmux —
 * the same seam discipline as buildGeneratorPrompt and the PaneDriver. An invalid model string is
 * NOT pre-validated here: claude surfaces it and monitorLiveness flags the session as stuck (the
 * codebase's never-silent stance), rather than a duplicated allow-list drifting from the CLI.
 */
export function buildLaunchCommand(opts: LaunchOpts): string {
  return buildInteractiveLaunchCommand(opts);
}

/** Launch an interactive Claude Code session as a WINDOW (tab) of the holder session. */
export function launchSession(opts: LaunchOpts): void {
  killSession(opts.session); // idempotent: close any stale tab of the same name
  ensureHolder(opts.cols ?? 200, opts.rows ?? 50);
  const res = tmux(['new-window', '-t', WINDOW_HOLDER, '-n', opts.session, '-c', opts.cwd, buildLaunchCommand(opts)]);
  if (!res.ok) throw new Error(`tmux new-window failed: ${res.stderr || res.stdout}`);
}

/** The three pane operations sendPrompt needs, behind a seam so its retry logic is unit-testable. */
export interface PaneDriver {
  type(session: string, text: string): void; // send-keys -l (literal)
  enter(session: string): void; // send-keys Enter (submit)
  capture(session: string): string; // capture-pane -p
}

const tmuxPaneDriver: PaneDriver = {
  // `-l` sends the string literally so tokens like `{`/`Enter` aren't interpreted as keys.
  type(session, text) {
    const r = tmux(['send-keys', '-t', target(session), '-l', text]);
    if (!r.ok) throw new Error(`tmux send-keys (text) failed: ${r.stderr}`);
  },
  enter(session) {
    const r = tmux(['send-keys', '-t', target(session), 'Enter']);
    if (!r.ok) throw new Error(`tmux send-keys (Enter) failed: ${r.stderr}`);
  },
  capture(session) {
    return tmux(['capture-pane', '-t', target(session), '-p']).stdout;
  },
};

/**
 * Submit-retry wiring (AC-PIN-003): the single exported source of sendPrompt's bounds —
 * how many Enter attempts before giving up, how long the TUI gets to react to each before
 * the Enter is judged dropped, and how long typed text gets to render before the first
 * pane comparison. Pinned by test so a value-breaking mutation cannot survive the suite
 * the way the old inline literals could.
 */
export const SUBMIT_RETRY = { attempts: 4, settleMs: 1500, renderMs: 400 } as const;

export interface SendPromptOpts {
  /** How many Enter attempts before giving up (default SUBMIT_RETRY.attempts). */
  attempts?: number;
  /** How long to wait for the TUI to react to an Enter before judging it dropped (default SUBMIT_RETRY.settleMs). */
  settleMs?: number;
  driver?: PaneDriver; // injectable for tests
  sleep?: (ms: number) => Promise<void>; // injectable for tests
}

/**
 * Type a prompt into the session and submit it, VERIFYING the submission took (returns whether it
 * did). A single `send-keys Enter` can be dropped before the TUI has committed the typed input —
 * under concurrency this stranded a review with its prompt typed-but-unsent, idling until the
 * liveness monitor flagged it stuck (observed in a grounded 6-lens run; the mock never sends a
 * prompt, so no unit test could have caught it). So we type once, then Enter-and-check in a bounded
 * loop: a submitted prompt makes the pane start changing (spinner/tokens), a dropped Enter leaves it
 * static → retry. If every attempt fails we return false and the caller's monitorLiveness still
 * surfaces the stuck session — never a silent hang.
 */
export async function sendPrompt(session: string, prompt: string, opts: SendPromptOpts = {}): Promise<boolean> {
  const driver = opts.driver ?? tmuxPaneDriver;
  const wait = opts.sleep ?? sleep;
  const attempts = opts.attempts ?? SUBMIT_RETRY.attempts;
  const settleMs = opts.settleMs ?? SUBMIT_RETRY.settleMs;

  driver.type(session, prompt);
  await wait(SUBMIT_RETRY.renderMs); // let the typed text render before we compare panes

  for (let i = 0; i < attempts; i++) {
    const before = driver.capture(session);
    driver.enter(session);
    await wait(settleMs);
    if (driver.capture(session) !== before) return true; // Enter took → the session started working
  }
  return false;
}

/** The visible pane text — used for evidence/debugging, never as a grading signal. */
export function capturePane(session: string): string {
  return tmux(['capture-pane', '-t', target(session), '-p']).stdout;
}

/** True iff the holder has a window (tab) for this session. */
export function sessionExists(session: string): boolean {
  const r = tmux(['list-windows', '-t', WINDOW_HOLDER, '-F', '#{window_name}']);
  return r.ok && r.stdout.split('\n').includes(session);
}

/** Close a role session's tab (kill its window). Ignore failure — it may already be gone. The
 *  holder's persistent home tab means closing the last role tab never kills the dashboard. */
export function killSession(session: string): void {
  tmux(['kill-window', '-t', target(session)]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type LivenessOutcome = 'completed' | 'stuck' | 'timeout';

export interface MonitorLivenessOpts {
  /** Pane unchanged this long with no sentinel = stuck (input-waiting / hung). */
  idleMs: number;
  /** Finite wall-clock ceiling for the whole watch: exceeding it without a sentinel is a
   *  timeout even mid-activity. Required so every caller commits to a finite bound — never
   *  an infinite wait. This and idleMs are the only two knobs that decide outcomes. */
  activeCapMs: number;
  pollMs: number;
  /** Injectable seams (default: real clock / timer / tmux pane / fs) so cap and stuck
   *  decisions are unit-testable on a virtual clock without a live session. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  capture?: (session: string) => string;
  sentinelExists?: (sentinelPath: string) => boolean;
}

/**
 * Watch a session until it completes or stops making progress (ARCH-execution-014/015).
 * Completion is confirmed ONLY by the sentinel (DOM-execution-005). In parallel we watch the
 * pane: while the agent works, the TUI keeps changing (spinner/token ticks), so a pane that
 * is unchanged for `idleMs` with no sentinel means the session is waiting for input or hung
 * — a stuck session, which must be surfaced, not silently timed out (DOM-execution-009).
 *
 * There is no per-session soft wall-clock cap (ISSUE-0007: a review that kept working 1h26m
 * past a 10-min cap was timed out and its findings lost). Exactly two knobs decide the
 * outcome: `idleMs` surfaces a session that stops working as stuck — including one that goes
 * idle deep into the watch — and `activeCapMs` finitely bounds one that never stops.
 *
 *   - 'completed' : sentinel appeared
 *   - 'stuck'     : pane idle for idleMs, no sentinel (input-waiting / hung)
 *   - 'timeout'   : exceeded the finite active ceiling (activeCapMs) without a sentinel
 */
export async function monitorLiveness(session: string, sentinelPath: string, opts: MonitorLivenessOpts): Promise<LivenessOutcome> {
  const now = opts.clock ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const capture = opts.capture ?? capturePane;
  const sentinelExists = opts.sentinelExists ?? ((p: string) => fs.existsSync(p));
  const start = now();
  let lastPane = capture(session);
  let lastChange = now();
  for (;;) {
    if (sentinelExists(sentinelPath)) return 'completed';
    if (now() - start > opts.activeCapMs) return 'timeout';
    const pane = capture(session);
    if (pane !== lastPane) {
      lastPane = pane;
      lastChange = now();
    }
    if (now() - lastChange > opts.idleMs) return 'stuck';
    await wait(opts.pollMs);
  }
}
