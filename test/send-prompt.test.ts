/**
 * sendPrompt submit-and-verify retry (fixes a grounded-run flake: a dropped `send-keys Enter` left
 * a review prompt typed-but-unsent, idling until the liveness monitor flagged it stuck). The tmux
 * I/O is injected as a fake driver: the prompt is typed ONCE, then Enter is retried until the pane
 * starts changing (submission took) or the attempts run out.
 */
import { describe, it, expect } from 'vitest';
import { sendPrompt, type PaneDriver } from '../src/pipeline/execution/tmux.js';

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
    const ok = await sendPrompt('s', 'do the thing', { driver, sleep: noSleep, attempts: 4 });
    expect(ok).toBe(false);
    expect(calls.enter).toBe(4); // tried the full budget
    expect(calls.type).toBe(1);
  });
});
