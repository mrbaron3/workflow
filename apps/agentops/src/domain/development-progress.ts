import { z } from 'zod';

/** Operator-facing phases shared by the runner, Control DB, CLI, and Dashboard. */
export const DevelopmentPhase = z.enum([
  'intake',
  'planning',
  'design',
  'generation',
  'validation',
  'review',
  'repair',
  'pull-request',
  'merge',
  'human-review',
  'completed',
  'failed',
]);
export type DevelopmentPhase = z.infer<typeof DevelopmentPhase>;

export const DevelopmentProgressState = z.enum([
  'pending',
  'running',
  'waiting',
  'blocked',
  'succeeded',
  'failed',
]);
export type DevelopmentProgressState = z.infer<typeof DevelopmentProgressState>;

const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable().optional();

/**
 * A structured phase transition. eventKey is stable within one durable job, so
 * retrying a reporting seam refreshes the same fact instead of duplicating it.
 */
export const DevelopmentProgressUpdate = z.object({
  eventKey: z.string().trim().min(1).max(200)
    .regex(/^[a-z0-9][a-z0-9:._/-]*$/),
  phase: DevelopmentPhase,
  step: z.string().trim().min(1).max(160),
  state: DevelopmentProgressState,
  summary: optionalText(1_000),
  nextGate: optionalText(500),
  blocker: optionalText(1_000),
  sessionName: optionalText(250),
  worktreePath: optionalText(2_000),
  branch: optionalText(500),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  parentIssueNumber: z.number().int().positive().nullable().optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable().optional(),
  reviewRound: z.number().int().positive().max(1_000).nullable().optional(),
  reviewOutcome: z.enum([
    'pending', 'running', 'approve', 'request-changes', 'escalated',
  ]).nullable().optional(),
  gateKey: z.enum([
    'planning', 'design', 'repository-graders', 'review', 'merge',
    'lease-recovery',
  ]).nullable().optional(),
  humanAction: optionalText(1_000),
}).strict();
export type DevelopmentProgressUpdate = z.infer<typeof DevelopmentProgressUpdate>;

export type DevelopmentProgressReporter = (
  update: DevelopmentProgressUpdate,
) => Promise<void>;
