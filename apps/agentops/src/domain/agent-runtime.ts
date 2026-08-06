import { z } from 'zod';

/** Tool/provider family that executes an agent invocation; model is a separate dimension. */
export const AgentProvider = z.enum(['claude', 'codex', 'gemini', 'mock']);
export type AgentProvider = z.infer<typeof AgentProvider>;

export const AgentRole = z.enum([
  'roadmap-planner',
  'issue-planner',
  'coordinator',
  'generator',
  'evaluator',
  'repair-router',
  'eval-curator',
  'release-manager',
  'harness-analyst',
  // system-layer view modelers — dispatched per-view by the to-system-design skill.
  'language-modeler',
  'domain-modeler',
  'architecture-modeler',
  'data-modeler',
  'context-mapper',
  'ui-designer',
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Roles that can own a runtime invocation. `reviewer` preserves the panel's current role name. */
export const InvocationRole = z.union([AgentRole, z.literal('reviewer')]);
export type InvocationRole = z.infer<typeof InvocationRole>;

export const InvocationOutcome = z.enum(['completed', 'stuck', 'timeout', 'failed']);
export type InvocationOutcome = z.infer<typeof InvocationOutcome>;

export const Verdict = z.enum(['approve', 'request_changes', 'needs_human']);
export type Verdict = z.infer<typeof Verdict>;
