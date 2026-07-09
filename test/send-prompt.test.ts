/**
 * sendPrompt submit-and-verify retry (fixes a grounded-run flake: a dropped `send-keys Enter` left
 * a review prompt typed-but-unsent, idling until the liveness monitor flagged it stuck). The tmux
 * I/O is injected as a fake driver: the prompt is typed ONCE, then Enter is retried until the pane
 * starts changing (submission took) or the attempts run out.
 */
import { describe, it, expect } from 'vitest';
import { sendPrompt, SUBMIT_RETRY, type PaneDriver } from '../src/pipeline/execution/tmux.js';

const noSleep = async (): Promise<void> => {};

/** A fake pane: static ("typed") until the `submitsAtEnter`-th Enter, then "processing". */
function fakeDriver(submitsAtEnter: number | null) {
  const calls = { type: 0, enter: 0, capture: 0 };
  let enters = 0;
  const driver: PaneDriver = {
    type: () => { calls.type++; },
    enter: () => { calls.enter++; enters++; },
    capture: () => { calls.capture++; return submitsAtEnter !== null && enters >= submitsAtEnter ? 'processing' : 'typed'; },
  };
  return { driver, calls };
}

describe('sendPrompt: verifies the prompt actually submitted', () => {
  it('returns true and types once when the first Enter takes', async () => {
    const { driver, calls } = fakeDriver(1);
    const ok = await sendPrompt('s', 'do the thing', { driver, sleep: noSleep });
    expect(ok).toBe(true);
    expect(calls.type).toBe(1);
    expect(calls.enter).toBe(1); // no wasted retries
  });

  it('retries Enter (without re-typing) until the pane starts changing', async () => {
    const { driver, calls } = fakeDriver(3); // first two Enters are dropped
    const ok = await sendPrompt('s', 'do the thing', { driver, sleep: noSleep, attempts: 5 });
    expect(ok).toBe(true);
    expect(calls.type).toBe(1); // typed once, never re-typed
    expect(calls.enter).toBe(3); // took on the third Enter
  });

  it('returns false after exhausting attempts when the Enter never registers (never silent)', async () => {
    const { driver, calls } = fakeDriver(null); // pane never changes
    const ok = await sendPrompt('s', 'do the thing', { driver, sleep: noSleep, attempts: SUBMIT_RETRY.attempts });
    expect(ok).toBe(false);
    expect(calls.enter).toBe(SUBMIT_RETRY.attempts); // tried the full budget — the single source, not a restated 4
    expect(calls.type).toBe(1);
  });

  // The defaults ARE the production wiring: both live callers pass no opts, so a re-inlined
  // literal at the `opts.x ?? SUBMIT_RETRY.x` fallback would silently shrink the retry budget
  // while every explicit-opts test above stayed green. This case pins the no-opts path to the
  // exported constant itself.
  it('ISSUE-0021/AC-PIN-003 the no-opts production path consumes SUBMIT_RETRY: its attempts of Enter, its renderMs once, its settleMs per attempt', async () => {
    const { driver, calls } = fakeDriver(null); // pane never changes → the full default budget runs
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => { slept.push(ms); };
    const ok = await sendPrompt('s', 'do the thing', { driver, sleep });
    expect(ok).toBe(false);
    expect(calls.enter).toBe(SUBMIT_RETRY.attempts); // default budget comes from the single source
    expect(slept[0]).toBe(SUBMIT_RETRY.renderMs); // typed-text render wait, no longer an inline 400
    expect(slept.slice(1)).toEqual(Array(SUBMIT_RETRY.attempts).fill(SUBMIT_RETRY.settleMs)); // per-attempt settle
  });
});
