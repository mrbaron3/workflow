import {
  CapabilityReconciliation,
  type CapabilityReconciliation as CapabilityReconciliationPlan,
  type ReconciledPlanningCandidate,
} from '../domain/schema.js';
import { resolveSystemContext } from '../pipeline/execution/scoped-context.js';

export const CAPABILITY_RECONCILIATION_REASON_CODES = [
  'schema-invalid',
  'ambiguity',
  'lineage-mismatch',
  'capability-set-empty',
  'duplicate-capability',
  'dangling-capability',
  'zero-capability-coverage',
  'duplicate-candidate',
  'duplicate-criterion',
  'frontend-candidate-missing',
  'backend-candidate-missing',
  'duplicate-dependency',
  'dangling-dependency',
  'dependency-cycle',
  'frontend-backend-dag-missing',
  'duplicate-api-operation',
  'duplicate-api-endpoint',
  'api-operation-owner-invalid',
  'orphan-api-operation',
  'zero-issue-coverage',
  'duplicate-issue-edge',
  'dangling-issue',
  'dangling-criterion',
  'zero-system-coverage',
  'duplicate-system-edge',
  'dangling-system',
  'zero-api-coverage',
  'duplicate-api-edge',
  'dangling-api-operation',
] as const;
export type CapabilityReconciliationReasonCode =
  (typeof CAPABILITY_RECONCILIATION_REASON_CODES)[number];

export interface CapabilityReconciliationReason {
  code: CapabilityReconciliationReasonCode;
  message: string;
}

export interface ApprovedCapabilitySet {
  requestId: string;
  revisionId: string;
  bundleDigest: string;
  /** Exact IDs returned by the validated Capability Requirements artifact. */
  capabilityIds: readonly string[];
}

export interface CapabilityReconciliationOptions {
  systemDir: string;
}

export type CapabilityReconciliationResult =
  | {
      status: 'accepted';
      plan: CapabilityReconciliationPlan;
      reasons: readonly [];
    }
  | {
      status: 'rejected';
      plan: null;
      reasons: readonly CapabilityReconciliationReason[];
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function sameIdentity(
  candidate: { requestId: string; revisionId: string; bundleDigest: string },
  approved: ApprovedCapabilitySet,
): boolean {
  return candidate.requestId === approved.requestId
    && candidate.revisionId === approved.revisionId
    && candidate.bundleDigest === approved.bundleDigest;
}

function formatSchemaIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '/'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validates the workflow-owned technical reconciliation for one approved Designflow revision.
 *
 * Capability Requirements contribute only opaque capability IDs. HTTP method/path, Issue
 * contracts, AC ownership, system elements, and the Issue DAG all come from this workflow plan.
 */
export function reconcileDesignCapabilities(
  rawPlan: unknown,
  approved: ApprovedCapabilitySet,
  options: CapabilityReconciliationOptions,
): CapabilityReconciliationResult {
  const parsed = CapabilityReconciliation.safeParse(rawPlan);
  if (!parsed.success) {
    return {
      status: 'rejected',
      plan: null,
      reasons: [{
        code: 'schema-invalid',
        message: `capability reconciliation schema validation failed: ${
          formatSchemaIssues(parsed.error.issues)
        }`,
      }],
    };
  }

  const plan = parsed.data;
  const reasons: CapabilityReconciliationReason[] = [];
  if (!sameIdentity(plan, approved)) {
    reasons.push({
      code: 'lineage-mismatch',
      message: 'capability reconciliation identity differs from the approved request/revision/bundle',
    });
  }
  for (const ambiguity of [...plan.ambiguities].sort(compareText)) {
    reasons.push({
      code: 'ambiguity',
      message: `unresolved capability reconciliation ambiguity: ${ambiguity}`,
    });
  }

  const expectedCapabilityDuplicates = duplicateValues(approved.capabilityIds);
  for (const capabilityId of expectedCapabilityDuplicates) {
    reasons.push({
      code: 'duplicate-capability',
      message: `approved Capability Requirements repeat ${capabilityId}`,
    });
  }
  const expectedCapabilities = new Set(approved.capabilityIds);
  if (expectedCapabilities.size === 0) {
    reasons.push({
      code: 'capability-set-empty',
      message: 'approved Capability Requirements contain zero capabilities',
    });
  }

  const candidateByKey = new Map<string, ReconciledPlanningCandidate>();
  const criterionIdsByCandidate = new Map<string, Set<string>>();
  const operationOwnerById = new Map<string, string>();
  const endpointOwner = new Map<string, string>();
  const candidates = [...plan.candidates]
    .sort((left, right) =>
      compareText(left.candidate.candidateKey, right.candidate.candidateKey));

  for (const wrapper of candidates) {
    const candidate = wrapper.candidate;
    if (candidateByKey.has(candidate.candidateKey)) {
      reasons.push({
        code: 'duplicate-candidate',
        message: `final planning repeats candidateKey ${candidate.candidateKey}`,
      });
    } else {
      candidateByKey.set(candidate.candidateKey, wrapper);
    }

    const criterionIds = candidate.contract.acceptanceCriteria
      .map((criterion) => criterion.id);
    for (const criterionId of duplicateValues(criterionIds)) {
      reasons.push({
        code: 'duplicate-criterion',
        message: `${candidate.candidateKey} repeats acceptance criterion ${criterionId}`,
      });
    }
    criterionIdsByCandidate.set(candidate.candidateKey, new Set(criterionIds));

    for (const operation of [...(candidate.contract.apiOperations ?? [])]
      .sort((left, right) => compareText(left.operationId, right.operationId))) {
      const existingOperationOwner = operationOwnerById.get(operation.operationId);
      if (existingOperationOwner !== undefined) {
        reasons.push({
          code: 'duplicate-api-operation',
          message: `API operation ${operation.operationId} is defined by both `
            + `${existingOperationOwner} and ${candidate.candidateKey}`,
        });
      } else {
        operationOwnerById.set(operation.operationId, candidate.candidateKey);
      }
      const endpoint = `${operation.method} ${operation.path}`;
      const existingEndpointOwner = endpointOwner.get(endpoint);
      if (existingEndpointOwner !== undefined) {
        reasons.push({
          code: 'duplicate-api-endpoint',
          message: `API endpoint ${endpoint} is defined more than once `
            + `(${existingEndpointOwner}, ${operation.operationId})`,
        });
      } else {
        endpointOwner.set(endpoint, operation.operationId);
      }
      if (candidate.area !== 'backend') {
        reasons.push({
          code: 'api-operation-owner-invalid',
          message: `workflow API operation ${operation.operationId} belongs to `
            + `${candidate.area} candidate ${candidate.candidateKey}, not backend planning`,
        });
      }
    }
  }

  const backendKeys = new Set(
    candidates
      .filter(({ candidate }) => candidate.area === 'backend')
      .map(({ candidate }) => candidate.candidateKey),
  );
  const frontendKeys = candidates
    .filter(({ candidate }) =>
      candidate.area === 'frontend' || candidate.area === 'fullstack')
    .map(({ candidate }) => candidate.candidateKey);
  if (backendKeys.size === 0) {
    reasons.push({
      code: 'backend-candidate-missing',
      message: 'capability reconciliation has no workflow-owned backend Issue candidate',
    });
  }
  if (frontendKeys.length === 0) {
    reasons.push({
      code: 'frontend-candidate-missing',
      message: 'capability reconciliation has no frontend/fullstack Issue candidate',
    });
  }

  for (const wrapper of candidates) {
    const key = wrapper.candidate.candidateKey;
    for (const duplicate of duplicateValues(wrapper.dependsOnCandidateKeys)) {
      reasons.push({
        code: 'duplicate-dependency',
        message: `${key} repeats dependency ${duplicate}`,
      });
    }
    for (const dependency of [...wrapper.dependsOnCandidateKeys].sort(compareText)) {
      if (dependency === key || !candidateByKey.has(dependency)) {
        reasons.push({
          code: 'dangling-dependency',
          message: `${key} depends on missing or self candidate ${dependency}`,
        });
      }
    }
  }

  const cycle = findDependencyCycle(candidateByKey);
  if (cycle !== null) {
    reasons.push({
      code: 'dependency-cycle',
      message: `final Issue dependency cycle: ${cycle.join(' -> ')}`,
    });
  }
  for (const frontendKey of frontendKeys.sort(compareText)) {
    if (!reachesBackend(frontendKey, candidateByKey, backendKeys, new Set())) {
      reasons.push({
        code: 'frontend-backend-dag-missing',
        message: `${frontendKey} has no dependency path to a backend Issue candidate`,
      });
    }
  }

  const bindingCount = new Map<string, number>();
  const referencedOperationIds = new Set<string>();
  const allSystemElementIds = new Set<string>();
  const bindings = [...plan.bindings]
    .sort((left, right) => compareText(left.capabilityId, right.capabilityId));
  for (const binding of bindings) {
    bindingCount.set(
      binding.capabilityId,
      (bindingCount.get(binding.capabilityId) ?? 0) + 1,
    );
    if ((bindingCount.get(binding.capabilityId) ?? 0) > 1) {
      reasons.push({
        code: 'duplicate-capability',
        message: `capability ${binding.capabilityId} has more than one coverage binding`,
      });
    }
    if (!expectedCapabilities.has(binding.capabilityId)) {
      reasons.push({
        code: 'dangling-capability',
        message: `coverage references unknown capability ${binding.capabilityId}`,
      });
    }
    if (!sameIdentity(binding, approved)) {
      reasons.push({
        code: 'lineage-mismatch',
        message: `capability ${binding.capabilityId} edge differs from the approved revision`,
      });
    }

    if (binding.issueEdges.length === 0) {
      reasons.push({
        code: 'zero-issue-coverage',
        message: `capability ${binding.capabilityId} has zero Issue/AC coverage`,
      });
    }
    const issueEdgeKeys = binding.issueEdges
      .map((edge) => `${edge.candidateKey}\0${edge.criterionId}`);
    for (const duplicate of duplicateValues(issueEdgeKeys)) {
      const [candidateKey, criterionId] = duplicate.split('\0');
      reasons.push({
        code: 'duplicate-issue-edge',
        message: `capability ${binding.capabilityId} repeats Issue/AC edge `
          + `${candidateKey}/${criterionId}`,
      });
    }
    let hasBackendIssueEdge = false;
    for (const edge of [...binding.issueEdges].sort((left, right) =>
      compareText(
        `${left.candidateKey}\0${left.criterionId}`,
        `${right.candidateKey}\0${right.criterionId}`,
      ))) {
      const candidate = candidateByKey.get(edge.candidateKey);
      if (!candidate) {
        reasons.push({
          code: 'dangling-issue',
          message: `capability ${binding.capabilityId} references unknown candidate `
            + edge.candidateKey,
        });
        continue;
      }
      if (candidate.candidate.area === 'backend') hasBackendIssueEdge = true;
      if (!criterionIdsByCandidate.get(edge.candidateKey)?.has(edge.criterionId)) {
        reasons.push({
          code: 'dangling-criterion',
          message: `capability ${binding.capabilityId} references unknown criterion `
            + `${edge.candidateKey}/${edge.criterionId}`,
        });
      }
    }
    if (binding.issueEdges.length > 0 && !hasBackendIssueEdge) {
      reasons.push({
        code: 'zero-issue-coverage',
        message: `capability ${binding.capabilityId} has no backend Issue/AC coverage`,
      });
    }

    if (binding.systemElementIds.length === 0) {
      reasons.push({
        code: 'zero-system-coverage',
        message: `capability ${binding.capabilityId} has zero system-element coverage`,
      });
    }
    for (const duplicate of duplicateValues(binding.systemElementIds)) {
      reasons.push({
        code: 'duplicate-system-edge',
        message: `capability ${binding.capabilityId} repeats system element ${duplicate}`,
      });
    }
    for (const systemElementId of binding.systemElementIds) {
      allSystemElementIds.add(systemElementId);
    }

    if (binding.apiOperationIds.length === 0) {
      reasons.push({
        code: 'zero-api-coverage',
        message: `capability ${binding.capabilityId} has zero workflow API coverage`,
      });
    }
    for (const duplicate of duplicateValues(binding.apiOperationIds)) {
      reasons.push({
        code: 'duplicate-api-edge',
        message: `capability ${binding.capabilityId} repeats API operation ${duplicate}`,
      });
    }
    for (const operationId of binding.apiOperationIds) {
      referencedOperationIds.add(operationId);
      if (!operationOwnerById.has(operationId)) {
        reasons.push({
          code: 'dangling-api-operation',
          message: `capability ${binding.capabilityId} references unknown workflow API `
            + operationId,
        });
      }
    }
  }

  for (const capabilityId of [...expectedCapabilities].sort(compareText)) {
    if ((bindingCount.get(capabilityId) ?? 0) === 0) {
      reasons.push({
        code: 'zero-capability-coverage',
        message: `capability ${capabilityId} has zero reconciliation coverage`,
      });
    }
  }
  for (const operationId of [...operationOwnerById.keys()].sort(compareText)) {
    if (!referencedOperationIds.has(operationId)) {
      reasons.push({
        code: 'orphan-api-operation',
        message: `workflow API operation ${operationId} is not required by any capability`,
      });
    }
  }

  const systemResolution = resolveSystemContext(
    [...allSystemElementIds].sort(compareText),
    options.systemDir,
  );
  for (const missing of systemResolution.missing) {
    reasons.push({
      code: 'dangling-system',
      message: `capability reconciliation references missing system element ${missing}`,
    });
  }

  if (reasons.length > 0) {
    return { status: 'rejected', plan: null, reasons };
  }

  return {
    status: 'accepted',
    plan: CapabilityReconciliation.parse({
      ...plan,
      candidates: candidates.map(({ candidate, dependsOnCandidateKeys }) => ({
        candidate: {
          ...candidate,
          contract: {
            ...candidate.contract,
            ...(candidate.contract.apiOperations
              ? {
                  apiOperations: [...candidate.contract.apiOperations]
                    .sort((left, right) =>
                      compareText(left.operationId, right.operationId)),
                }
              : {}),
          },
        },
        dependsOnCandidateKeys: [...dependsOnCandidateKeys].sort(compareText),
      })),
      bindings: bindings.map((binding) => ({
        ...binding,
        issueEdges: [...binding.issueEdges].sort((left, right) =>
          compareText(
            `${left.candidateKey}\0${left.criterionId}`,
            `${right.candidateKey}\0${right.criterionId}`,
          )),
        systemElementIds: [...binding.systemElementIds].sort(compareText),
        apiOperationIds: [...binding.apiOperationIds].sort(compareText),
      })),
      ambiguities: [],
    }),
    reasons: [],
  };
}

function findDependencyCycle(
  candidates: ReadonlyMap<string, ReconciledPlanningCandidate>,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (candidateKey: string): string[] | null => {
    if (visiting.has(candidateKey)) {
      const start = path.indexOf(candidateKey);
      return [...path.slice(start), candidateKey];
    }
    if (visited.has(candidateKey)) return null;
    visiting.add(candidateKey);
    path.push(candidateKey);
    const dependencies = candidates.get(candidateKey)?.dependsOnCandidateKeys ?? [];
    for (const dependency of [...dependencies].sort(compareText)) {
      if (!candidates.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(candidateKey);
    visited.add(candidateKey);
    return null;
  };

  for (const candidateKey of [...candidates.keys()].sort(compareText)) {
    const cycle = visit(candidateKey);
    if (cycle) return cycle;
  }
  return null;
}

function reachesBackend(
  candidateKey: string,
  candidates: ReadonlyMap<string, ReconciledPlanningCandidate>,
  backendKeys: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  if (visited.has(candidateKey)) return false;
  visited.add(candidateKey);
  const dependencies = candidates.get(candidateKey)?.dependsOnCandidateKeys ?? [];
  for (const dependency of dependencies) {
    if (backendKeys.has(dependency)) return true;
    if (candidates.has(dependency)
      && reachesBackend(dependency, candidates, backendKeys, visited)) {
      return true;
    }
  }
  return false;
}
