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
} from '../src/designflow/capability-reconciliation.js';
import {
  DesignflowContractConsumer,
  digestDesignflowArtifact,
} from '../src/designflow/contract-consumer.js';
import {
  evaluateMaterializedDesignDecisionGate,
} from '../src/designflow/decision-gate.js';
import {
  projectMaterializedDesignBundleReview,
} from '../src/designflow/review-projection.js';

const REPOSITORY_ROOT = process.cwd();
const DESIGN_ROOT = 'evidence/ciso-05/design';
const REVISION_01 = `${DESIGN_ROOT}/revision-01`;
const REVISION_02 = `${DESIGN_ROOT}/revision-02`;
const DESIGN_REQUEST = `${DESIGN_ROOT}/design-request.json`;

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
  requestId: string;
  revisionId: string;
  previousRevisionId: string;
  capabilities: GoldenCapability[];
  coverageSummary: {
    capabilityCount: number;
    reconciledCapabilityCount: number;
    unreconciledCapabilityIds: string[];
    allOwnedByIssue: string;
    allOwnedByAcceptanceCriterion: string;
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8'),
  ) as T;
}

function materialization(
  revisionRoot: string,
  decisionPath: string,
) {
  return {
    bundleRoot: REPOSITORY_ROOT,
    manifestPath: `${revisionRoot}/design-bundle-manifest.json`,
    designRequestPath: DESIGN_REQUEST,
    humanDecisionPath: decisionPath,
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
      userStory: 'As an operator, I inspect and change registrations safely',
      scope: {
        include: area === 'backend' ? ['src/control/**'] : ['src/dashboard/**'],
        exclude: [],
      },
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

function reconciliationPlan(
  approved: ApprovedCapabilitySet,
  golden: GoldenReconciliation,
): CapabilityReconciliationInput {
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
    schemaVersion: '1.0',
    requestId: approved.requestId,
    revisionId: approved.revisionId,
    bundleDigest: approved.bundleDigest,
    candidates: [
      {
        candidate: candidate(
          'ciso-control-api',
          'backend',
          'AC-CISO-010',
          operations,
        ),
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
  };
}

describe('WF-DF-008 CISO-05 grounded golden replay', () => {
  it('joins #15 WHAT, request-changes, revision-02 approval, projection, and all 7 capabilities', () => {
    const request = readJson<Record<string, any>>(DESIGN_REQUEST);
    const sourceIssueBytes = fs.readFileSync(
      path.join(REPOSITORY_ROOT, `${DESIGN_ROOT}/source-issue-15.json`),
    );
    expect(digestDesignflowArtifact(sourceIssueBytes, 'application/json'))
      .toBe(request.sourceRef.digest);
    expect(request.sourceRef.externalId).toBe('mrbaron3/workflow#15');
    expect(request.requirements).toHaveLength(7);

    const requestChangesInput = materialization(
      REVISION_01,
      `${DESIGN_ROOT}/decisions/request-changes-r01.json`,
    );
    const requested = evaluateMaterializedDesignDecisionGate(requestChangesInput);
    expect(requested.status).toBe('needs-human-review');
    expect(requested.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['decision-request-changes', 'unresolved-ambiguity']),
    );

    const approvedInput = materialization(
      REVISION_02,
      `${DESIGN_ROOT}/decisions/approve-r02.json`,
    );
    const gate = evaluateMaterializedDesignDecisionGate(approvedInput);
    expect(gate).toEqual({
      status: 'approved',
      requestId: 'workflow-ciso05-dashboard-20260726',
      revisionId: 'workflow-ciso05-dashboard-r02',
      bundleDigest:
        'sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa',
      decisionId: 'workflow-ciso05-dashboard-r02-approve',
      supersedesDecisionId: 'workflow-ciso05-dashboard-r01-request-changes',
      reasons: [],
    });
    expect(readJson<Record<string, unknown>>(
      `${DESIGN_ROOT}/decisions/approve-r02.json`,
    ).supersedesDecisionId).toBe('workflow-ciso05-dashboard-r01-request-changes');

    const consumer = new DesignflowContractConsumer({
      repositoryRoot: REPOSITORY_ROOT,
    });
    const contract = consumer.validateBundle(approvedInput);
    expect(contract).toMatchObject({
      requestId: gate.requestId,
      revisionId: gate.revisionId,
      bundleDigest: gate.bundleDigest,
      decisionId: gate.decisionId,
      decisionVerdict: 'approve',
      decisionSupersedesDecisionId: gate.supersedesDecisionId,
    });
    expect(contract.capabilityIds).toHaveLength(7);

    const review = projectMaterializedDesignBundleReview(approvedInput);
    expect(review.identity.previousRevisionId).toBe('workflow-ciso05-dashboard-r01');
    expect(review.purposes).toHaveLength(1);
    expect(review.tasks).toHaveLength(5);
    expect(review.effortBudgets).toHaveLength(5);
    expect(review.attentionHierarchy).toHaveLength(1);
    expect(review.elements).toHaveLength(29);
    expect(review.elements.every((element) =>
      element.placementRationale.length > 0
      && element.removalImpact.length > 0)).toBe(true);
    expect(review.ambiguities).toEqual([]);

    const golden = readJson<GoldenReconciliation>(
      `${REVISION_02}/capability-reconciliation.json`,
    );
    const approved: ApprovedCapabilitySet = {
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      bundleDigest: contract.bundleDigest,
      capabilityIds: contract.capabilityIds,
    };
    const reconciled = reconcileDesignCapabilities(
      reconciliationPlan(approved, golden),
      approved,
      { systemDir: path.join(REPOSITORY_ROOT, 'docs', '_system') },
    );
    expect(reconciled.status).toBe('accepted');
    if (reconciled.status !== 'accepted') return;
    expect(reconciled.plan.bindings).toHaveLength(7);
    expect(reconciled.plan.bindings.map((binding) => binding.capabilityId))
      .toEqual([...contract.capabilityIds].sort());
    expect(reconciled.plan.candidates[0]!.candidate.contract.apiOperations)
      .toHaveLength(9);
    expect(golden.coverageSummary).toMatchObject({
      capabilityCount: 7,
      reconciledCapabilityCount: 7,
      unreconciledCapabilityIds: [],
      allOwnedByIssue: 'mrbaron3/workflow#15',
      allOwnedByAcceptanceCriterion: 'AC-CISO-010',
    });
  });
});
