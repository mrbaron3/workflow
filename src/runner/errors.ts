import type {
  RunnerCriticalBoundary,
  RunnerFailureCode,
  RunnerJobFailureV1,
} from '../control-store/types.js';

export class RunnerExecutionError extends Error {
  override readonly name = 'RunnerExecutionError';

  constructor(
    readonly code: RunnerFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly boundary: RunnerCriticalBoundary | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toFailure(now: Date = new Date()): RunnerJobFailureV1 {
    return {
      schemaVersion: 1,
      status: 'failed',
      code: this.code,
      message: this.message.slice(0, 2_000),
      retryable: this.retryable,
      boundary: this.boundary,
      observedAt: now.toISOString(),
    };
  }
}

export function runnerFailure(error: unknown): RunnerJobFailureV1 {
  if (error instanceof RunnerExecutionError) return error.toFailure();
  return new RunnerExecutionError(
    'internal_failure',
    error instanceof Error ? error.message : String(error),
    true,
    null,
    error instanceof Error ? { cause: error } : undefined,
  ).toFailure();
}
