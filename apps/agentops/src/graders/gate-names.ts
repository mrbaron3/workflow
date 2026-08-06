/**
 * Canonical repository-grader signal namespace.
 *
 * Keep this list separate from VerificationMethod: similar spelling does not
 * imply that `unit_test` and `unit_tests`, for example, are interchangeable.
 */
export const HARD_GATE_SIGNAL_NAMES = [
  'build',
  'typecheck',
  'unit_tests',
  'api_tests',
  'grader_profile',
  'secrets_scan',
  'scope_check',
  'playwright',
] as const;

export type HardGateSignalName = (typeof HARD_GATE_SIGNAL_NAMES)[number];
