import type { AgentProvider } from '../../domain/schema.js';
import { providerReadyPattern } from '../../agents/interactive-backend.js';
import { capturePane, sendPrompt } from './tmux.js';

/** Maximum time both generator and reviewer sessions may take to become interactive. */
export const INTERACTIVE_SESSION_READY_TIMEOUT_MS = 20_000;
export const INTERACTIVE_SESSION_READY_POLL_MS = 500;

export interface SessionReadinessPorts {
  capture: (session: string) => string;
  submit: (session: string, prompt: string) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_PORTS: SessionReadinessPorts = {
  capture: capturePane,
  submit: sendPrompt,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SessionPromptSubmission {
  readiness: 'ready' | 'timeout';
  submitted: boolean;
}

/**
 * Wait for a provider's interactive footer before submitting a prompt. A timeout
 * fails closed: text is never sent to a pane that may still be a shell, setup
 * wizard, or other unintended input target.
 */
export async function submitPromptWhenSessionReady(
  session: string,
  provider: AgentProvider,
  prompt: string,
  ports: SessionReadinessPorts = DEFAULT_PORTS,
): Promise<SessionPromptSubmission> {
  const ready = providerReadyPattern(provider);
  const deadline = ports.now() + INTERACTIVE_SESSION_READY_TIMEOUT_MS;
  while (true) {
    if (ready.test(ports.capture(session))) {
      return {
        readiness: 'ready',
        submitted: await ports.submit(session, prompt),
      };
    }
    const remainingMs = deadline - ports.now();
    if (remainingMs <= 0) {
      return { readiness: 'timeout', submitted: false };
    }
    await ports.sleep(Math.min(INTERACTIVE_SESSION_READY_POLL_MS, remainingMs));
  }
}
