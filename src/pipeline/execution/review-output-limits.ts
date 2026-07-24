/** Hard limits for untrusted provider output retained by the long-running daemon. */
export const MAX_RESTRICTED_REVIEW_OUTPUT_BYTES = 256 * 1024;
export const MAX_REVIEW_FINDINGS = 100;
export const MAX_REVIEW_CRITERION_ID_CHARS = 256;
export const MAX_REVIEW_FINDING_TEXT_CHARS = 10_000;
export const MAX_REVIEW_REQUIRED_FIXES = 20;
export const MAX_REVIEW_REQUIRED_FIX_CHARS = 4_000;
