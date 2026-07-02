/**
 * Low-level tmux session substrate (ARCH-execution-003, realising DOM-execution-002/005).
 *
 * A role runs as an INTERACTIVE, detached, attachable Claude Code session inside its own
 * tmux window — not `claude -p` headless (North Star: headless is a non-goal; a human can
 * `tmux attach` to review/intervene). The exact recipe below was validated by a live smoke
 * test: no trust prompt in a fresh dir, `acceptEdits` writes files without per-edit prompts,
 * `send-keys -l` drives the input, and the agent hands control back by writing a sentinel.
 *
 * These are thin wrappers over the `tmux` CLI; all orchestration decisions (when to launch,
 * when to grade) live in deterministic code above this seam (ARCH-execution-011).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export interface LaunchOpts {
  session: string;
  cwd: string;
  /** Tools the interactive session may use without prompting. Kept tight so a detached
   *  session never hangs on an unexpected approval (grading is the harness's job). */
  allowedTools?: string[];
  /** Permission mode; `acceptEdits` = semi-autonomous HOW (P1), no per-edit approval. */
  permissionMode?: 'acceptEdits' | 'default' | 'plan';
  cols?: number;
  rows?: number;
}

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('tmux', args, { encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Launch an interactive Claude Code session, detached, in its own tmux window. */
export function launchSession(opts: LaunchOpts): void {
  const allowed = (opts.allowedTools ?? ['Read', 'Edit', 'Write']).join(' ');
  const claude =
    `claude -n ${opts.session} ` +
    `--permission-mode ${opts.permissionMode ?? 'acceptEdits'} ` +
    `--allowedTools '${allowed}'`;
  killSession(opts.session); // idempotent: clear any stale window of the same name
  const res = tmux([
    'new-session',
    '-d',
    '-s',
    opts.session,
    '-x',
    String(opts.cols ?? 200),
    '-y',
    String(opts.rows ?? 50),
    '-c',
    opts.cwd,
    claude,
  ]);
  if (!res.ok) throw new Error(`tmux new-session failed: ${res.stderr || res.stdout}`);
}

/** Type a prompt into the session's input and submit it (literal keys, then Enter). */
export function sendPrompt(session: string, prompt: string): void {
  // `-l` sends the string literally so tokens like `{`/`Enter` aren't interpreted as keys.
  const typed = tmux(['send-keys', '-t', session, '-l', prompt]);
  if (!typed.ok) throw new Error(`tmux send-keys (text) failed: ${typed.stderr}`);
  const enter = tmux(['send-keys', '-t', session, 'Enter']);
  if (!enter.ok) throw new Error(`tmux send-keys (Enter) failed: ${enter.stderr}`);
}

/** The visible pane text — used for evidence/debugging, never as a grading signal. */
export function capturePane(session: string): string {
  return tmux(['capture-pane', '-t', session, '-p']).stdout;
}

export function sessionExists(session: string): boolean {
  return tmux(['has-session', '-t', session]).ok;
}

export function killSession(session: string): void {
  tmux(['kill-session', '-t', session]); // ignore failure (may not exist)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type LivenessOutcome = 'completed' | 'stuck' | 'timeout';

/**
 * Watch a session until it completes or stops making progress (ARCH-execution-014/015).
 * Completion is confirmed ONLY by the sentinel (DOM-execution-005). In parallel we watch the
 * pane: while the agent works, the TUI keeps changing (spinner/token ticks), so a pane that
 * is unchanged for `idleMs` with no sentinel means the session is waiting for input or hung
 * — a stuck session, which must be surfaced, not silently timed out (DOM-execution-009).
 *
 *   - 'completed' : sentinel appeared
 *   - 'stuck'     : pane idle for idleMs, no sentinel (input-waiting / hung)
 *   - 'timeout'   : exceeded hardCapMs regardless of pane activity
 */
export async function monitorLiveness(
  session: string,
  sentinelPath: string,
  opts: { idleMs: number; hardCapMs: number; pollMs: number },
): Promise<LivenessOutcome> {
  const start = Date.now();
  let lastPane = capturePane(session);
  let lastChange = Date.now();
  for (;;) {
    if (fs.existsSync(sentinelPath)) return 'completed';
    if (Date.now() - start > opts.hardCapMs) return 'timeout';
    const pane = capturePane(session);
    if (pane !== lastPane) {
      lastPane = pane;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange > opts.idleMs) return 'stuck';
    await sleep(opts.pollMs);
  }
}
