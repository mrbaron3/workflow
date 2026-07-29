/** WF-DF-006 — approved capabilities become workflow-owned API/system/Issue/AC edges. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  CapabilityReconciliationInput,
  EnrichmentCandidate,
  WorkflowApiOperation,
} from '../src/domain/schema.js';
import {
  reconcileDesignCapabilities,
  type ApprovedCapabilitySet,
  type CapabilityReconciliationReasonCode,
} from '../src/designflow/capability-reconciliation.js';
import {
  DesignBundleManifestSchema,
  evaluateDesignDecisionGate,
  HumanDesignDecisionSchema,
} from '../src/designflow/decision-gate.js';

const REPOSITORY_ROOT = process.cwd();
const CISO_ROOT = path.join(REPOSITORY_ROOT, 'evidence', 'ciso-05', 'design');
const REVISION_ROOT = path.join(CISO_ROOT, 'revision-02');

interface GoldenCapability {
  capabilityId: string;
  plannedHttpOperations: Array<{
    method: WorkflowApiOperation['method'];
    path: string;
    purpose: string;
  }>;
  architectureElementIds: string[];
  ownership: {
    issue: string;
    acceptanceCriterion: string;
  };
}

interface GoldenReconciliation {
  documentType: string;
  requestId: string;
  revisionId: string;
  capabilities: GoldenCapability[];
  coverageSummary: {
    capabilityCount: number;
    reconciledCapabilityCount: number;
    unreconciledCapabilityIds: string[];
    allOwnedByIssue: string;
    allOwnedByAcceptanceCriterion: string;
  };
}

interface CapabilityRequirementsFixture {
  requestId: string;
  revisionId: string;
  capabilities: Array<Record<string, unknown> & { id: string }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function cisoApprovedSet(): ApprovedCapabilitySet {
  const manifest = DesignBundleManifestSchema.parse(
    readJson(path.join(REVISION_ROOT, 'design-bundle-manifest.json')),
  );
  const decision = HumanDesignDecisionSchema.parse(
    readJson(path.join(CISO_ROOT, 'decisions', 'approve-r02.json')),
  );
  const artifacts: Record<string, Buffer> = {};
  for (const reference of Object.values(manifest.artifacts)) {
    if (reference) {
      artifacts[reference.path] = fs.readFileSync(
        path.join(REPOSITORY_ROOT, reference.path),
      );
    }
  }
  const gate = evaluateDesignDecisionGate({
    manifest,
    source: fs.readFileSync(path.join(CISO_ROOT, 'design-request.json')),
    artifacts,
    decision,
  });
  if (gate.status !== 'approved' || !gate.requestId || !gate.revisionId
    || !gate.bundleDigest) {
    throw new Error(`CISO Design Bundle is not approved: ${JSON.stringify(gate.reasons)}`);
  }
  const requirements = readJson<CapabilityRequirementsFixture>(
    path.join(REVISION_ROOT, 'capability-requirements.json'),
  );
  return {
    requestId: gate.requestId,
    revisionId: gate.revisionId,
    bundleDigest: gate.bundleDigest,
    capabilityIds: requirements.capabilities.map((capability) => capability.id),
  };
}

function candidate(
  candidateKey: string,
  area: 'frontend' | 'backend',
  criterionId: string,
  apiOperations?: WorkflowApiOperation[],
): EnrichmentCandidate {
  return {
    candidateKey,
    title: `Implement ${candidateKey}`,
    type: 'feature',
    area,
    contract: {
      productGoal: 'Operate registrations safely from the approved Dashboard',
      userStory: 'As an operator, I can inspect and change registrations safely',
      scope: { include: area === 'backend' ? ['src/control/**'] : ['src/dashboard/**'], exclude: [] },
      acceptanceCriteria: [{
        id: criterionId,
        severity: 'blocker',
        behavior: `${candidateKey} fulfills the approved capability contract`,
        verification: {
          method: area === 'backend' ? 'api_test' : 'playwright',
          expected: ['The approved behavior is observable'],
        },
      }],
      redLines: ['Do not expose provider or database credentials'],
      ...(apiOperations ? { apiOperations } : {}),
    },
    traces: [],
  };
}

function cisoPlan(approved: ApprovedCapabilitySet): {
  plan: CapabilityReconciliationInput;
  golden: GoldenReconciliation;
  requirements: CapabilityRequirementsFixture;
} {
  const golden = readJson<GoldenReconciliation>(
    path.join(REVISION_ROOT, 'capability-reconciliation.json'),
  );
  const requirements = readJson<CapabilityRequirementsFixture>(
    path.join(REVISION_ROOT, 'capability-requirements.json'),
  );
  const operationIdsByCapability = new Map<string, string[]>();
  const operations = golden.capabilities.flatMap((capability) =>
    capability.plannedHttpOperations.map((operation, index) => {
      const operationId = `${capability.capabilityId}-api-${index + 1}`;
      const ids = operationIdsByCapability.get(capability.capabilityId) ?? [];
      ids.push(operationId);
      operationIdsByCapability.set(capability.capabilityId, ids);
      return { operationId, ...operation };
    }));

  return {
    golden,
    requirements,
    plan: {
      schemaVersion: '1.0',
      requestId: approved.requestId,
      revisionId: approved.revisionId,
      bundleDigest: approved.bundleDigest,
      candidates: [
        {
          candidate: candidate('ciso-control-api', 'backend', 'AC-CISO-010', operations),
          dependsOnCandidateKeys: [],
        },
        {
          candidate: candidate('ciso-dashboard', 'frontend', 'AC-CISO-010'),
          dependsOnCandidateKeys: ['ciso-control-api'],
        },
      ],
      bindings: golden.capabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        requestId: approved.requestId,
        revisionId: approved.revisionId,
        bundleDigest: approved.bundleDigest,
        issueEdges: [
          {
            candidateKey: 'ciso-control-api',
            criterionId: capability.ownership.acceptanceCriterion,
          },
          {
            candidateKey: 'ciso-dashboard',
            criterionId: capability.ownership.acceptanceCriterion,
          },
        ],
        systemElementIds: capability.architectureElementIds,
        apiOperationIds: operationIdsByCapability.get(capability.capabilityId) ?? [],
      })),
      ambiguities: [],
    },
  };
}

function reasonCodes(
  result: ReturnType<typeof reconcileDesignCapabilities>,
): CapabilityReconciliationReasonCode[] {
  return result.reasons.map((reason) => reason.code);
}

describe('Designflow capability reconciliation', () => {
  it('golden-replays all seven CISO capabilities through the generic approved-revision gate', () => {
    const approved = cisoApprovedSet();
    const { plan, golden, requirements } = cisoPlan(approved);

    const result = reconcileDesignCapabilities(
      plan,
      approved,
      { systemDir: path.join(REPOSITORY_ROOT, 'docs', '_system') },
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(golden.documentType).toBe('workflow-ciso05-capability-reconciliation');
    expect(result.plan.bindings.map((binding) => binding.capabilityId))
      .toEqual(requirements.capabilities.map((capability) => capability.id).sort());
    expect(result.plan.bindings).toHaveLength(7);
    expect(result.plan.candidates[0]!.candidate.contract.apiOperations).toHaveLength(9);
    expect(result.plan.candidates[1]!.dependsOnCandidateKeys)
      .toEqual(['ciso-control-api']);
    expect(golden.coverageSummary).toMatchObject({
      capabilityCount: 7,
      reconciledCapabilityCount: 7,
      unreconciledCapabilityIds: [],
      allOwnedByIssue: 'mrbaron3/workflow#15',
      allOwnedByAcceptanceCriterion: 'AC-CISO-010',
    });
    for (const binding of result.plan.bindings) {
      const fixture = golden.capabilities.find(
        (capability) => capability.capabilityId === binding.capabilityId,
      )!;
      expect(binding.issueEdges.map((edge) => edge.criterionId))
        .toEqual(['AC-CISO-010', 'AC-CISO-010']);
      expect(binding.systemElementIds).toEqual([...fixture.architectureElementIds].sort());
      expect(binding.apiOperationIds).toHaveLength(fixture.plannedHttpOperations.length);
    }

    // Provider artifacts state semantic needs; only the workflow reconciliation owns endpoints.
    for (const capability of requirements.capabilities) {
      expect(Object.keys(capability)).not.toContain('plannedHttpOperations');
    }
    expect(golden.capabilities.every((capability) =>
      capability.plannedHttpOperations.length > 0)).toBe(true);
  });

  it.each([
    [
      'zero coverage',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings = plan.bindings?.slice(1);
      },
      'zero-capability-coverage',
    ],
    [
      'dangling Issue',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.issueEdges![0]!.candidateKey = 'missing-candidate';
      },
      'dangling-issue',
    ],
    [
      'dangling AC',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.issueEdges![0]!.criterionId = 'AC-MISSING';
      },
      'dangling-criterion',
    ],
    [
      'dangling system element',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.systemElementIds = ['ARCH-registration-control-999'];
      },
      'dangling-system',
    ],
    [
      'dangling API operation',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.apiOperationIds = ['missing-operation'];
      },
      'dangling-api-operation',
    ],
    [
      'duplicate capability edge',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings!.push(structuredClone(plan.bindings![0]!));
      },
      'duplicate-capability',
    ],
    [
      'duplicate Issue/AC edge',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.issueEdges!.push(
          structuredClone(plan.bindings![0]!.issueEdges![0]!),
        );
      },
      'duplicate-issue-edge',
    ],
    [
      'duplicate system edge',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.systemElementIds!.push(
          plan.bindings![0]!.systemElementIds![0]!,
        );
      },
      'duplicate-system-edge',
    ],
    [
      'duplicate API edge',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.apiOperationIds!.push(
          plan.bindings![0]!.apiOperationIds![0]!,
        );
      },
      'duplicate-api-edge',
    ],
    [
      'mixed revision edge',
      (plan: CapabilityReconciliationInput) => {
        plan.bindings![0]!.revisionId = 'workflow-ciso05-dashboard-r01';
      },
      'lineage-mismatch',
    ],
  ] as const)(
    'rejects %s all-or-nothing',
    (_name, mutate, expectedCode) => {
      const approved = cisoApprovedSet();
      const { plan } = cisoPlan(approved);
      const mutated = structuredClone(plan);
      mutate(mutated);

      const result = reconcileDesignCapabilities(
        mutated,
        approved,
        { systemDir: path.join(REPOSITORY_ROOT, 'docs', '_system') },
      );

      expect(result.status).toBe('rejected');
      expect(result.plan).toBeNull();
      expect(reasonCodes(result)).toContain(expectedCode);
    },
  );

  it('rejects duplicate endpoints and a frontend/backend dependency cycle', () => {
    const approved = cisoApprovedSet();
    const { plan } = cisoPlan(approved);
    const mutated = structuredClone(plan);
    const backend = mutated.candidates[0]!;
    const frontend = mutated.candidates[1]!;
    backend.dependsOnCandidateKeys = ['ciso-dashboard'];
    frontend.candidate.contract.apiOperations = [{
      ...backend.candidate.contract.apiOperations![0]!,
      operationId: 'frontend-owned-copy',
    }];

    const result = reconcileDesignCapabilities(
      mutated,
      approved,
      { systemDir: path.join(REPOSITORY_ROOT, 'docs', '_system') },
    );

    expect(result.status).toBe('rejected');
    expect(reasonCodes(result)).toEqual(expect.arrayContaining([
      'dependency-cycle',
      'duplicate-api-endpoint',
      'api-operation-owner-invalid',
    ]));
  });
});
