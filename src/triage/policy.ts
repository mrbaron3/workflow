import { z } from 'zod';
import type { TriageDecisionV1 } from '../control-store/types.js';

const Label = z.string().trim().min(1).max(50).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/,
  'triage labels must be bounded plain text',
);

export const TriagePolicyContract = z.object({
  readyLabel: Label,
  claimedLabel: Label,
  readyCandidateLabel: Label,
  blockedLabel: Label,
  needsInfoLabel: Label,
  contextPaths: z.array(
    z.string().min(1).max(200).regex(
      /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/,
      'triage context paths must be repository-relative',
    ),
  ).min(1).max(16),
}).strict().superRefine((policy, context) => {
  const labels = [
    policy.readyLabel,
    policy.claimedLabel,
    policy.readyCandidateLabel,
    policy.blockedLabel,
    policy.needsInfoLabel,
  ];
  if (new Set(labels).size !== labels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readyLabel'],
      message: 'triage labels must be distinct',
    });
  }
});
export type TriagePolicy = z.infer<typeof TriagePolicyContract>;

export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {
  readyLabel: 'ready',
  claimedLabel: 'agent-claimed',
  readyCandidateLabel: 'ready-candidate',
  blockedLabel: 'blocked',
  needsInfoLabel: 'needs-info',
  contextPaths: [
    'README.md',
    'AGENTS.md',
    'docs/NORTH_STAR.md',
    'docs/ROADMAP.md',
    'docs/roadmap.yaml',
  ],
};

export function managedTriageLabels(policy: TriagePolicy): string[] {
  return [
    policy.readyCandidateLabel,
    policy.blockedLabel,
    policy.needsInfoLabel,
  ];
}

export function labelForDecision(
  policy: TriagePolicy,
  decision: TriageDecisionV1,
): string {
  switch (decision.readiness) {
    case 'ready_candidate':
      return policy.readyCandidateLabel;
    case 'blocked':
      return policy.blockedLabel;
    case 'needs_info':
      return policy.needsInfoLabel;
  }
}

export function loadTriagePolicy(
  environment: NodeJS.ProcessEnv,
): TriagePolicy {
  let contextPaths = DEFAULT_TRIAGE_POLICY.contextPaths;
  const rawPaths = environment.AGENTOPS_TRIAGE_CONTEXT_PATHS_JSON;
  if (rawPaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPaths);
    } catch {
      throw new Error('AGENTOPS_TRIAGE_CONTEXT_PATHS_JSON must be JSON');
    }
    contextPaths = z.array(z.string()).parse(parsed);
  }
  return TriagePolicyContract.parse({
    readyLabel:
      environment.AGENTOPS_TRIAGE_READY_LABEL ?? DEFAULT_TRIAGE_POLICY.readyLabel,
    claimedLabel:
      environment.AGENTOPS_TRIAGE_CLAIMED_LABEL ?? DEFAULT_TRIAGE_POLICY.claimedLabel,
    readyCandidateLabel:
      environment.AGENTOPS_TRIAGE_CANDIDATE_LABEL
      ?? DEFAULT_TRIAGE_POLICY.readyCandidateLabel,
    blockedLabel:
      environment.AGENTOPS_TRIAGE_BLOCKED_LABEL ?? DEFAULT_TRIAGE_POLICY.blockedLabel,
    needsInfoLabel:
      environment.AGENTOPS_TRIAGE_NEEDS_INFO_LABEL
      ?? DEFAULT_TRIAGE_POLICY.needsInfoLabel,
    contextPaths,
  });
}
