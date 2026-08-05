import { describe, expect, it } from 'vitest';
import {
  INTERACTIVE_SESSION_READY_POLL_MS,
  INTERACTIVE_SESSION_READY_TIMEOUT_MS,
  submitPromptWhenSessionReady,
  type SessionReadinessPorts,
} from '../src/pipeline/execution/session-readiness.js';

describe('interactive session readiness', () => {
  it('PR-INTENT pins the shared timeout and submits only after the provider is ready', async () => {
    expect(INTERACTIVE_SESSION_READY_TIMEOUT_MS).toBe(20_000);
    const events: string[] = [];
    let ready = false;
    let releasePoll: (() => void) | undefined;
    const ports: SessionReadinessPorts = {
      capture: () => ready ? 'Claude footer ❯' : 'starting',
      submit: async () => {
        events.push('submit');
        return true;
      },
      now: () => 0,
      sleep: async () => {
        events.push('poll');
        await new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
      },
    };

    const pending = submitPromptWhenSessionReady('session', 'claude', 'review', ports);
    await Promise.resolve();
    expect(events).toEqual(['poll']);
    ready = true;
    releasePoll?.();

    await expect(pending).resolves.toEqual({ readiness: 'ready', submitted: true });
    expect(events).toEqual(['poll', 'submit']);
  });

  it('PR-INTENT fails closed without submitting when readiness reaches the shared timeout', async () => {
    let now = 0;
    let submissions = 0;
    const ports: SessionReadinessPorts = {
      capture: () => 'still starting',
      submit: async () => {
        submissions += 1;
        return true;
      },
      now: () => now,
      sleep: async (ms) => {
        expect(ms).toBeLessThanOrEqual(INTERACTIVE_SESSION_READY_POLL_MS);
        now += ms;
      },
    };

    await expect(submitPromptWhenSessionReady('session', 'codex', 'build', ports))
      .resolves.toEqual({ readiness: 'timeout', submitted: false });
    expect(now).toBe(INTERACTIVE_SESSION_READY_TIMEOUT_MS);
    expect(submissions).toBe(0);
  });
});
