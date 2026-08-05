/** WF-DF-003 — UI planning pauses at a deterministic Design Request until approval. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordAgentInvocation } from '../src/agents/invocation.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  ApprovedDesignReviewProjection,
  DesignDraftCandidate,
  IntakeRecord,
  PlanningEnrichmentRecord,
  type DesignRequest,
  type EnrichmentCandidate,
} from '../src/domain/schema.js';
import {
  digestDesignflowArtifact,
  type DesignflowContractResult,
} from '../src/designflow/contract-consumer.js';
import type {
  DesignDecisionGateReasonCode,
  DesignDecisionGateResult,
} from '../src/designflow/decision-gate.js';
import {
  projectDesignBundleReview,
  type DesignBundleReviewInput,
} from '../src/designflow/review-projection.js';
import { runGithubDevelopmentTurn } from '../src/intake/development-turn.js';
import type { GithubIssueRunner } from '../src/intake/github-issues.js';
import {
  applyPlanningEnrichment,
  buildDesignRequest,
  finalizeDesignPlanning,
} from '../src/intake/planning-enrichment.js';
import { pollable } from '../src/pipeline/execution/guard.js';
import { Store } from '../src/store/store.js';

const roots: string[] = [];

function createRoot(): { root: string; systemDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-designflow-planning-'));
  roots.push(root);
  const systemDir = path.join(root, 'docs', '_system');
  fs.mkdirSync(path.join(systemDir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, 'test', 'domain-model.md'),
    '- **DOM-test-001 Stable domain rule** — retain the stable rule.\n',
    'utf8',
  );
  return { root, systemDir };
}

function addClaimedIntake(store: Store): string {
  const intakeKey = 'github:acme%2Ftheme:42';
  store.addIntakeRecord(IntakeRecord.parse({
    id: 'INTAKE-0001',
    intakeKey,
    provider: 'github',
    status: 'claimed',
    snapshot: {
      repository: 'acme/theme',
      number: 42,
      externalId: 'I_42',
      title: 'Add export action',
      body: 'Users must export a report as CSV. Keep the stable domain rule.',
      url: 'https://github.com/acme/theme/issues/42',
      labels: ['ready'],
      state: 'open',
      sourceUpdatedAt: '2026-07-14T00:00:00.000Z',
      snapshotAt: '2026-07-14T01:00:00.000Z',
    },
    claimedAt: '2026-07-14T01:00:01.000Z',
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T01:00:01.000Z',
  }));
  return intakeKey;
}

function config(withIntake = false): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    routes: {
      generator: { provider: 'codex', model: 'gpt-5.1-codex' },
      planning: { provider: 'claude', model: 'opus' },
    },
    ...(withIntake
      ? {
          intake: {
            backend: 'github' as const,
            repository: 'acme/theme',
            readyLabel: 'ready',
            claimedLabel: 'agent-claimed',
            designProviders: { 'ui-export': 'designflow' as const },
          },
        }
      : {}),
  };
}

function designDraft() {
  return {
    candidateKey: 'ui-export',
    title: 'Design CSV export action',
    type: 'feature' as const,
    area: 'frontend' as const,
    productIntent: {
      primaryOutcome: 'Users export the current report without losing context',
      users: ['Report operators', 'Analysts', 'Analysts'],
      usageContext: 'While reviewing a report in the web application',
    },
    requirements: [
      {
        id: 'REQ-UI-002',
        statement: 'The export action preserves the stable domain rule',
        priority: 'major' as const,
      },
      {
        id: 'REQ-UI-001',
        statement: 'Users can start CSV export from the report',
        priority: 'blocker' as const,
      },
    ],
    constraints: [
      {
        id: 'CON-UI-002',
        category: 'technical' as const,
        statement: 'Reuse the current report boundary',
      },
      {
        id: 'CON-UI-001',
        category: 'accessibility' as const,
        statement: 'The action is keyboard operable',
      },
    ],
    targetSurfaces: ['web' as const, 'desktop' as const, 'web' as const],
    existingDesignSystemRef: {
      provider: 'git',
      externalId: 'acme-design-system',
      uri: 'https://example.test/acme/design-system',
      revision: 'main',
    },
    traces: [
      {
        requirementId: 'REQ-UI-002',
        sources: [
          { kind: 'system' as const, elementId: 'DOM-test-001' },
          { kind: 'source' as const, text: 'Keep the stable domain rule' },
        ],
      },
      {
        requirementId: 'REQ-UI-001',
        sources: [
          { kind: 'system' as const, elementId: 'DOM-test-001' },
          { kind: 'source' as const, text: 'export a report as CSV' },
        ],
      },
    ],
  };
}

function backendCandidate(): EnrichmentCandidate {
  return {
    candidateKey: 'export-api',
    title: 'Implement CSV export API',
    type: 'feature',
    area: 'backend',
    contract: {
      productGoal: 'Users can export reports',
      userStory: 'As a user, I can export a report as CSV',
      scope: { include: ['src/api/**'], exclude: [] },
      acceptanceCriteria: [{
        id: 'AC-API-001',
        severity: 'blocker',
        behavior: 'The report API returns CSV',
        verification: { method: 'api_test', expected: ['CSV is returned'] },
      }],
      redLines: [],
    },
    traces: [{
      criterionId: 'AC-API-001',
      sources: [{ kind: 'source', text: 'export a report as CSV' }],
    }],
  };
}

function finalBackendCandidate(): EnrichmentCandidate {
  const candidate = backendCandidate();
  return {
    ...candidate,
    title: 'Implement approved CSV export API',
    contract: {
      ...candidate.contract,
      apiOperations: [{
        operationId: 'export-report',
        method: 'POST',
        path: '/v1/reports/export',
        purpose: 'Start the approved CSV report export',
      }],
    },
  };
}

function finalUiCandidate(): EnrichmentCandidate {
  return {
    candidateKey: 'ui-export',
    title: 'Implement approved CSV export action',
    type: 'feature',
    area: 'frontend',
    contract: {
      productGoal: 'Users can export reports without losing context',
      userStory: 'As an analyst, I start CSV export from the report',
      scope: { include: ['src/ui/**'], exclude: [] },
      acceptanceCriteria: [
        {
          id: 'AC-UI-001',
          severity: 'blocker',
          behavior: 'The report exposes the approved CSV export action',
          verification: { method: 'playwright', expected: ['CSV export starts'] },
        },
        {
          id: 'AC-UI-002',
          severity: 'major',
          behavior: 'The action respects the stable report boundary',
          verification: { method: 'unit_test', expected: ['Domain state remains stable'] },
        },
      ],
      redLines: [],
    },
    traces: [
      {
        criterionId: 'AC-UI-001',
        sources: [{ kind: 'source', text: 'export a report as CSV' }],
      },
      {
        criterionId: 'AC-UI-002',
        sources: [
          { kind: 'source', text: 'Keep the stable domain rule' },
          { kind: 'system', elementId: 'DOM-test-001' },
        ],
      },
    ],
  };
}

function approvedContract(
  request: DesignRequest,
  overrides: Partial<DesignflowContractResult> = {},
): DesignflowContractResult {
  return {
    providerRef: 'mrbaron3/designflow@contract-v1.0.0-rc.1',
    providerCommit: 'c'.repeat(40),
    contractDigest: `sha256:${'a'.repeat(64)}`,
    bundleId: 'bundle-ui-export-001',
    requestId: request.requestId,
    revisionId: 'revision-ui-export-001',
    sourceDigest: digestDesignflowArtifact(
      Buffer.from(JSON.stringify(request), 'utf8'),
      'application/json',
    ),
    bundleDigest: `sha256:${'b'.repeat(64)}`,
    artifactIds: ['capabilityRequirements', 'designSystemDelta', 'experience'],
    capabilityIds: ['CAP-EXPORT-001'],
    decisionId: 'decision-ui-export-001',
    decisionVerdict: 'approve',
    decisionSupersedesDecisionId: null,
    ...overrides,
  };
}

function approvedDecisionGate(
  contract: DesignflowContractResult,
): DesignDecisionGateResult {
  return {
    status: 'approved',
    requestId: contract.requestId,
    revisionId: contract.revisionId,
    bundleDigest: contract.bundleDigest,
    decisionId: contract.decisionId ?? null,
    supersedesDecisionId: contract.decisionSupersedesDecisionId ?? null,
    reasons: [],
  };
}

function reviewInput(contract: DesignflowContractResult): DesignBundleReviewInput {
  const artifact = (name: string) => ({
    path: `${name}.json`,
    digest: `sha256:${name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`,
    mediaType: 'application/json',
    schemaRef: `urn:designflow:schema:v1:${name}`,
  });
  return {
    manifest: {
      schemaVersion: '1.0',
      bundleId: contract.bundleId,
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      previousRevisionId: null,
      sourceDigest: contract.sourceDigest,
      artifacts: {
        experience: artifact('experience'),
        designSystemDelta: artifact('design-system-delta'),
        capabilityRequirements: artifact('capability-requirements'),
        preview: {
          ...artifact('preview'),
          path: 'preview.html',
          mediaType: 'text/html',
        },
      },
      bundleDigest: contract.bundleDigest,
      createdAt: '2026-07-28T00:00:00.000Z',
    },
    experience: {
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      pagePurposes: [{
        id: 'purpose-export',
        name: 'Report export',
        primaryPurpose: 'Let analysts export the current report',
        successOutcome: 'The export starts without losing report context',
        secondaryPurposes: [],
        outOfScope: [],
        sourceRequirementIds: ['REQ-UI-001'],
      }],
      tasks: [{
        id: 'task-export',
        pagePurposeId: 'purpose-export',
        goal: 'Start the current report export',
        criticality: 'primary',
        frequency: 'frequent',
        sourceRequirementIds: ['REQ-UI-001'],
      }],
      effortBudgets: [{
        id: 'effort-export',
        taskId: 'task-export',
        maxPrimaryActions: 1,
        maxDecisions: 1,
        maxContextSwitches: 0,
        repeatedInputAllowed: false,
        rationale: 'Export is a direct report action',
      }],
      regions: [{
        id: 'region-actions',
        pagePurposeId: 'purpose-export',
        purpose: 'Expose report actions',
        order: 1,
        groupingRationale: 'Actions stay with the report',
        prominence: 'primary',
        responsiveBehavior: 'Remain visible at supported widths',
        supportsTaskIds: ['task-export'],
      }],
      elements: [{
        id: 'element-export',
        regionId: 'region-actions',
        kind: 'button',
        label: 'Export',
        supportsPurposeIds: ['purpose-export'],
        supportsTaskIds: ['task-export'],
        informationPriority: 1,
        visibleWhen: 'A report is available',
        placementRationale: 'The action belongs with the current report',
        interactionRationale: 'One activation starts export',
        removalImpact: 'Analysts cannot export from the report',
        sourceRequirementIds: ['REQ-UI-001'],
      }],
      attentionHierarchies: [{
        pagePurposeId: 'purpose-export',
        levels: [{
          level: 1,
          reason: 'The primary export task is immediately available',
          regionIds: ['region-actions'],
          elementIds: ['element-export'],
        }],
      }],
      ambiguities: [],
    },
    designSystemDelta: {
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      baseRevisionRef: null,
      decisions: [{
        id: 'decision-export-action',
        action: 'reuse',
        targetType: 'component',
        targetId: 'button',
        rationale: 'The existing button expresses the action',
        sourceRequirementIds: ['REQ-UI-001'],
      }],
      tokenDocuments: [],
      componentDeltas: [],
      patternDeltas: [],
    },
    capabilityRequirements: {
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      capabilities: contract.capabilityIds.map((capabilityId) => ({
        id: capabilityId,
        kind: 'command' as const,
        userIntent: 'Start report export',
        sourceInteractionIds: ['element-export'],
        sourceRequirementIds: ['REQ-UI-001'],
        inputDescription: 'Current report identity',
        successOutcome: 'Export starts',
        failureSemantics: [{
          condition: 'Export cannot start',
          userVisibleOutcome: 'A retryable error is shown',
          recoverability: 'retry',
        }],
        authorization: 'The analyst may read the report',
        latencyExpectation: 'Acknowledge within one second',
        freshnessExpectation: 'Use the current report revision',
        concurrencySemantics: 'One export per activation',
        idempotencySemantics: 'Retry does not duplicate the export',
        retrySemantics: 'Explicit retry is safe',
        cancellationSemantics: 'Cancellation is visible',
        paginationSemantics: 'Not applicable',
        auditSemantics: 'Record the initiating analyst',
      })),
      ambiguities: [],
    },
    revisionDiff: '# Approved export design\n\nInitial workflow projection.',
  };
}

function approvedReview(contract: DesignflowContractResult) {
  return ApprovedDesignReviewProjection.parse(
    projectDesignBundleReview(reviewInput(contract)),
  );
}

function rejectedDecisionGate(
  contract: DesignflowContractResult,
  code: DesignDecisionGateReasonCode,
): DesignDecisionGateResult {
  return {
    status: 'needs-human-review',
    requestId: contract.requestId,
    revisionId: contract.revisionId,
    bundleDigest: contract.bundleDigest,
    decisionId: contract.decisionId ?? null,
    supersedesDecisionId: contract.decisionSupersedesDecisionId ?? null,
    reasons: [{
      code,
      message: `fixture rejection: ${code}`,
    }],
  };
}

function capabilityReconciliation(contract: DesignflowContractResult) {
  return {
    schemaVersion: '1.0' as const,
    requestId: contract.requestId,
    revisionId: contract.revisionId,
    bundleDigest: contract.bundleDigest,
    candidates: [
      {
        candidate: finalBackendCandidate(),
        dependsOnCandidateKeys: [],
      },
      {
        candidate: finalUiCandidate(),
        dependsOnCandidateKeys: ['export-api'],
      },
    ],
    bindings: [{
      capabilityId: 'CAP-EXPORT-001',
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      bundleDigest: contract.bundleDigest,
      issueEdges: [
        { candidateKey: 'export-api', criterionId: 'AC-API-001' },
        { candidateKey: 'ui-export', criterionId: 'AC-UI-001' },
      ],
      systemElementIds: ['DOM-test-001'],
      apiOperationIds: ['export-report'],
    }],
    ambiguities: [],
  };
}

function setupGate() {
  const { root, systemDir } = createRoot();
  const store = new Store(root);
  const intakeKey = addClaimedIntake(store);
  const invocation = recordAgentInvocation(store, {
    subjectId: intakeKey,
    attempt: 1,
    role: 'issue-planner',
    perspective: null,
    provider: 'claude',
    model: 'opus',
    prompt: 'draft requirements',
    outcome: 'completed',
  });
  store.save();
  return {
    root,
    systemDir,
    store,
    intakeKey,
    invocationKey: invocation.invocationKey,
    config: config(true),
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Designflow planning gate', () => {
  it('derives a stable Design Request from the immutable source, requirements, and system traces', () => {
    const env = setupGate();
    const draft = designDraft();
    const reordered = {
      ...draft,
      productIntent: {
        ...draft.productIntent,
        users: [...draft.productIntent.users].reverse(),
      },
      requirements: [...draft.requirements].reverse(),
      constraints: [...draft.constraints].reverse(),
      targetSurfaces: [...draft.targetSurfaces].reverse(),
      traces: [...draft.traces].reverse().map((trace) => ({
        ...trace,
        sources: [...trace.sources].reverse(),
      })),
    };

    const first = buildDesignRequest(env.store.intakeByKey(env.intakeKey)!, draft);
    const second = buildDesignRequest(env.store.intakeByKey(env.intakeKey)!, reordered);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: '1.0',
      sourceRef: {
        provider: 'github',
        externalId: 'acme/theme#42',
        revision: '2026-07-14T00:00:00.000Z',
      },
      requirements: [
        { id: 'REQ-UI-001' },
        { id: 'REQ-UI-002' },
      ],
      targetSurfaces: ['desktop', 'web'],
      contextRefs: [{ provider: 'workflow-system', externalId: 'DOM-test-001' }],
      requestedAt: '2026-07-14T01:00:00.000Z',
    });
    expect(first.requestId).toMatch(/^workflow-design-[a-f0-9]{24}$/);
    expect(first.sourceRef.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects a pre-approval IssueContract anywhere in the strict Design draft boundary', () => {
    const env = setupGate();
    const draft = designDraft();
    const issueContract = finalUiCandidate().contract;
    const topLevelSmuggle = { ...draft, contract: issueContract };
    const nestedSmuggle = {
      ...draft,
      requirements: draft.requirements.map((requirement, index) =>
        index === 0 ? { ...requirement, contract: issueContract } : requirement),
    };

    expect(DesignDraftCandidate.safeParse(topLevelSmuggle).success).toBe(false);
    expect(DesignDraftCandidate.safeParse(nestedSmuggle).success).toBe(false);

    const rejected = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      { candidates: [], designDrafts: [topLevelSmuggle], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('Unrecognized key');
    expect(rejected.designDrafts).toEqual([]);
    expect(env.store.db.issues).toEqual([]);
  });

  it('persists one draft and zero Issues until approval, then finalizes exactly once after restart', () => {
    const env = setupGate();
    const output = {
      candidates: [backendCandidate()],
      designDrafts: [designDraft()],
      ambiguities: [],
    };
    const issueCounterBefore = env.store.db.counters.ISSUE;
    const pending = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      output,
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );

    expect(pending).toMatchObject({
      status: 'awaiting-design',
      issueIds: [],
      pendingCandidates: [{ candidate: { candidateKey: 'export-api' } }],
      designDrafts: [{ candidate: { candidateKey: 'ui-export' } }],
    });
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
    expect(env.store.intakeByKey(env.intakeKey)?.status).toBe('design-pending');

    const countersAfterDraft = { ...env.store.db.counters };
    const restarted = new Store(env.root);
    const duplicate = applyPlanningEnrichment(
      restarted,
      env.config,
      env.intakeKey,
      { candidates: [backendCandidate()], designDrafts: [], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    expect(duplicate).toEqual(pending);
    expect(restarted.db.planningEnrichments).toHaveLength(1);
    expect(restarted.db.counters).toEqual(countersAfterDraft);

    const request = duplicate.designDrafts[0]!.designRequest;
    const contract = approvedContract(request);
    const accepted = finalizeDesignPlanning(
      restarted,
      env.config,
      env.intakeKey,
      [{
        candidateKey: 'ui-export',
        contract,
        decisionGate: approvedDecisionGate(contract),
        reviewProjection: approvedReview(contract),
        reconciliation: capabilityReconciliation(contract),
      }],
      { systemDir: env.systemDir },
    );
    const countersAfterApproval = { ...restarted.db.counters };
    const repeated = finalizeDesignPlanning(
      restarted,
      env.config,
      env.intakeKey,
      [{
        candidateKey: 'ui-export',
        contract,
        decisionGate: approvedDecisionGate(contract),
        reviewProjection: approvedReview(contract),
        reconciliation: capabilityReconciliation(contract),
      }],
      { systemDir: env.systemDir },
    );

    expect(accepted.status).toBe('accepted');
    expect(repeated).toEqual(accepted);
    expect(restarted.db.counters).toEqual(countersAfterApproval);
    expect(restarted.db.issues).toHaveLength(2);
    expect(restarted.db.issues[0]).toMatchObject({
      planningCandidateKey: 'export-api',
      designRequestId: request.requestId,
      designRevisionId: 'revision-ui-export-001',
      designCapabilityIds: ['CAP-EXPORT-001'],
      contract: {
        apiOperations: [{
          operationId: 'export-report',
          method: 'POST',
          path: '/v1/reports/export',
        }],
      },
    });
    expect(restarted.db.issues[1]).toMatchObject({
      planningCandidateKey: 'ui-export',
      designRequestId: request.requestId,
      designRevisionId: 'revision-ui-export-001',
      designBundleDigest: `sha256:${'b'.repeat(64)}`,
      designCapabilityIds: ['CAP-EXPORT-001'],
      dependsOnIssues: [restarted.db.issues[0]!.id],
    });
    expect(restarted.db.issues.map((issue) => issue.designAuthority)).toEqual([
      expect.objectContaining({
        provider: 'designflow',
        candidateKey: 'export-api',
        requestId: request.requestId,
        revisionId: 'revision-ui-export-001',
      }),
      expect.objectContaining({
        provider: 'designflow',
        candidateKey: 'ui-export',
        requestId: request.requestId,
        revisionId: 'revision-ui-export-001',
      }),
    ]);
    expect(accepted.designProviderSelections).toEqual([
      { candidateKey: 'export-api', provider: 'designflow' },
      { candidateKey: 'ui-export', provider: 'designflow' },
    ]);
    expect(restarted.db.issues.every((issue) =>
      issue.designReview?.identity.revisionId === 'revision-ui-export-001')).toBe(true);
    expect(restarted.db.issues[0]?.designReview).toEqual(
      restarted.db.issues[1]?.designReview,
    );
    expect(accepted.approvedDesigns[0]?.reviewProjection)
      .toEqual(restarted.db.issues[0]?.designReview);
    expect(accepted.capabilityCoverage).toHaveLength(2);
    expect(new Set(accepted.capabilityCoverage.map((edge) => edge.capabilityId)))
      .toEqual(new Set(['CAP-EXPORT-001']));
    expect(restarted.intakeByKey(env.intakeKey)).toMatchObject({
      status: 'ready',
      storeIssueIds: accepted.issueIds,
    });
    const persisted = new Store(env.root);
    expect(persisted.planningEnrichmentFor(env.intakeKey)?.capabilityCoverage)
      .toEqual(accepted.capabilityCoverage);
    expect(persisted.db.issues.map((issue) => issue.designRevisionId))
      .toEqual(['revision-ui-export-001', 'revision-ui-export-001']);
  });

  it.each([
    ['request-changes', 'decision-request-changes'],
    ['stale approval', 'stale-approval'],
    ['digest mismatch', 'bundle-digest-mismatch'],
  ] as const)(
    'fails closed on %s gate output before allocating Issues or coverage',
    (_name, reasonCode) => {
      const env = setupGate();
      const pending = applyPlanningEnrichment(
        env.store,
        env.config,
        env.intakeKey,
        { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
        { systemDir: env.systemDir, invocationKey: env.invocationKey },
      );
      const request = pending.designDrafts[0]!.designRequest;
      const contract = approvedContract(request);
      const issueCounterBefore = env.store.db.counters.ISSUE;

      const rejected = finalizeDesignPlanning(
        env.store,
        env.config,
        env.intakeKey,
        [{
          candidateKey: 'ui-export',
          contract: null,
          decisionGate: rejectedDecisionGate(contract, reasonCode),
          reviewProjection: null,
          reconciliation: null,
        }],
        { systemDir: env.systemDir },
      );

      expect(rejected.status).toBe('needs-human-review');
      expect(rejected.reasons.join('\n')).toContain(reasonCode);
      expect(rejected.issueIds).toEqual([]);
      expect(rejected.capabilityCoverage).toEqual([]);
      expect(env.store.db.issues).toEqual([]);
      expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
      expect(env.store.intakeByKey(env.intakeKey)?.status)
        .toBe('needs-human-review');
    },
  );

  it.each([
    ['requestId', 'other-request'],
    ['revisionId', 'other-revision'],
    ['bundleDigest', `sha256:${'c'.repeat(64)}`],
    ['decisionId', 'other-decision'],
  ] as const)(
    'rejects an approved gate result whose exact %s belongs to another bundle',
    (field, value) => {
      const env = setupGate();
      const pending = applyPlanningEnrichment(
        env.store,
        env.config,
        env.intakeKey,
        { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
        { systemDir: env.systemDir, invocationKey: env.invocationKey },
      );
      const contract = approvedContract(pending.designDrafts[0]!.designRequest);
      const issueCounterBefore = env.store.db.counters.ISSUE;
      const mismatchedGate = {
        ...approvedDecisionGate(contract),
        [field]: value,
      };

      const rejected = finalizeDesignPlanning(
        env.store,
        env.config,
        env.intakeKey,
        [{
          candidateKey: 'ui-export',
          contract,
          decisionGate: mismatchedGate,
          reviewProjection: approvedReview(contract),
          reconciliation: capabilityReconciliation(contract),
        }],
        { systemDir: env.systemDir },
      );

      expect(rejected.status).toBe('needs-human-review');
      expect(rejected.reasons.join('\n')).toContain('identity/verdict');
      expect(rejected.capabilityCoverage).toEqual([]);
      expect(env.store.db.issues).toEqual([]);
      expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
    },
  );

  it.each(['missing', 'revision', 'digest', 'capability'] as const)(
    'rejects an approved contract whose review projection has %s drift',
    (drift) => {
      const env = setupGate();
      const pending = applyPlanningEnrichment(
        env.store,
        env.config,
        env.intakeKey,
        { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
        { systemDir: env.systemDir, invocationKey: env.invocationKey },
      );
      const contract = approvedContract(pending.designDrafts[0]!.designRequest);
      const validReview = approvedReview(contract);
      const reviewProjection = drift === 'missing'
        ? null
        : ApprovedDesignReviewProjection.parse({
            ...validReview,
            ...(drift === 'revision'
              ? {
                  identity: {
                    ...validReview.identity,
                    revisionId: 'other-review-revision',
                  },
                }
              : {}),
            ...(drift === 'digest'
              ? {
                  digest: {
                    ...validReview.digest,
                    bundleDigest: `sha256:${'f'.repeat(64)}`,
                  },
                }
              : {}),
            ...(drift === 'capability'
              ? {
                  capabilityDelta: [{
                    ...validReview.capabilityDelta[0],
                    id: 'CAP-OTHER-001',
                  }],
                }
              : {}),
          });
      const issueCounterBefore = env.store.db.counters.ISSUE;

      const rejected = finalizeDesignPlanning(
        env.store,
        env.config,
        env.intakeKey,
        [{
          candidateKey: 'ui-export',
          contract,
          decisionGate: approvedDecisionGate(contract),
          reviewProjection,
          reconciliation: capabilityReconciliation(contract),
        }],
        { systemDir: env.systemDir },
      );

      expect(rejected.status).toBe('needs-human-review');
      expect(rejected.reasons.join('\n')).toContain(
        drift === 'missing' ? 'has no WF-DF-005' : 'review projection identity/content',
      );
      expect(rejected.issueIds).toEqual([]);
      expect(env.store.db.issues).toEqual([]);
      expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
    },
  );

  it('does not infer a provider from an old Designflow-shaped draft with no selection', () => {
    const env = setupGate();
    const pending = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    env.store.replacePlanningEnrichment(PlanningEnrichmentRecord.parse({
      ...pending,
      designProviderSelections: [],
    }));
    const contract = approvedContract(pending.designDrafts[0]!.designRequest);

    const rejected = finalizeDesignPlanning(
      env.store,
      env.config,
      env.intakeKey,
      [{
        candidateKey: 'ui-export',
        contract,
        decisionGate: approvedDecisionGate(contract),
        reviewProjection: approvedReview(contract),
        reconciliation: capabilityReconciliation(contract),
      }],
      { systemDir: env.systemDir },
    );

    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('no exclusive explicit');
    expect(env.store.db.issues).toEqual([]);
  });

  it('rejects a consumed bundle bound to another Design Request body', () => {
    const rejectedEnv = setupGate();
    const rejectedPending = applyPlanningEnrichment(
      rejectedEnv.store,
      rejectedEnv.config,
      rejectedEnv.intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      { systemDir: rejectedEnv.systemDir, invocationKey: rejectedEnv.invocationKey },
    );
    const rejectedRequest = rejectedPending.designDrafts[0]!.designRequest;
    const issueCounterBefore = rejectedEnv.store.db.counters.ISSUE;
    const rejectedContract = approvedContract(rejectedRequest, {
      sourceDigest: `sha256:${'0'.repeat(64)}`,
    });
    const rejected = finalizeDesignPlanning(
      rejectedEnv.store,
      rejectedEnv.config,
      rejectedEnv.intakeKey,
      [{
        candidateKey: 'ui-export',
        contract: rejectedContract,
        decisionGate: approvedDecisionGate(rejectedContract),
        reviewProjection: approvedReview(rejectedContract),
        reconciliation: capabilityReconciliation(rejectedContract),
      }],
      { systemDir: rejectedEnv.systemDir },
    );
    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('sourceDigest');
    expect(rejectedEnv.store.db.issues).toEqual([]);
    expect(rejectedEnv.store.db.counters.ISSUE).toBe(issueCounterBefore);
  });

  it('rejects incomplete capability coverage before allocating any Issue or durable edge', () => {
    const env = setupGate();
    const pending = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const request = pending.designDrafts[0]!.designRequest;
    const contract = approvedContract(request);
    const reconciliation = capabilityReconciliation(contract);
    reconciliation.bindings = [];
    const issueCounterBefore = env.store.db.counters.ISSUE;

    const rejected = finalizeDesignPlanning(
      env.store,
      env.config,
      env.intakeKey,
      [{
        candidateKey: 'ui-export',
        contract,
        decisionGate: approvedDecisionGate(contract),
        reviewProjection: approvedReview(contract),
        reconciliation,
      }],
      { systemDir: env.systemDir },
    );

    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('zero-capability-coverage');
    expect(rejected.capabilityCoverage).toEqual([]);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
  });

  it('stops the runtime path at WF-DF-004 before consuming or reconciling a rejected bundle', async () => {
    const env = setupGate();
    const pending = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const request = pending.designDrafts[0]!.designRequest;
    const contract = approvedContract(request, { decisionVerdict: 'request-changes' });
    let consumerCalls = 0;
    let reconcilerCalls = 0;

    await runGithubDevelopmentTurn(env.store, config(true), {
      issueRunner: {
        listReadyIssues: () => [],
        claimIssue: () => {
          throw new Error('the already-claimed intake must not be claimed again');
        },
      },
      designflowResolver: async () => ({
        bundle: {
          bundleRoot: '/provider/rejected-candidate',
          manifestPath: 'manifest.json',
          designRequestPath: 'request.json',
          humanDecisionPath: 'decision.json',
        },
      }),
      designflowDecisionGate: () =>
        rejectedDecisionGate(contract, 'decision-request-changes'),
      designflowConsumer: {
        validateBundle() {
          consumerCalls += 1;
          return contract;
        },
      },
      designflowCapabilityReconciler: async () => {
        reconcilerCalls += 1;
        return capabilityReconciliation(contract);
      },
      driveQueue: async () => [],
    }, env.root);

    const rejected = env.store.planningEnrichmentFor(env.intakeKey)!;
    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('decision-request-changes');
    expect(rejected.capabilityCoverage).toEqual([]);
    expect(env.store.db.issues).toEqual([]);
    expect(consumerCalls).toBe(0);
    expect(reconcilerCalls).toBe(0);
  });

  it('terminally rejects a materialized resolution whose bundle is missing or unsafe', async () => {
    const env = setupGate();
    const pending = applyPlanningEnrichment(
      env.store,
      env.config,
      env.intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      { systemDir: env.systemDir, invocationKey: env.invocationKey },
    );
    const contract = approvedContract(pending.designDrafts[0]!.designRequest);
    const issueCounterBefore = env.store.db.counters.ISSUE;
    let consumerCalls = 0;
    let reconcilerCalls = 0;

    await runGithubDevelopmentTurn(env.store, config(true), {
      issueRunner: {
        listReadyIssues: () => [],
        claimIssue: () => {
          throw new Error('the already-claimed intake must not be claimed again');
        },
      },
      designflowResolver: async () => ({
        bundle: {
          bundleRoot: env.root,
          manifestPath: 'missing-manifest.json',
          designRequestPath: 'missing-request.json',
          humanDecisionPath: 'missing-decision.json',
        },
      }),
      designflowConsumer: {
        validateBundle() {
          consumerCalls += 1;
          return contract;
        },
      },
      designflowCapabilityReconciler: async () => {
        reconcilerCalls += 1;
        return capabilityReconciliation(contract);
      },
      driveQueue: async () => [],
    }, env.root);

    const rejected = env.store.planningEnrichmentFor(env.intakeKey)!;
    expect(rejected.status).toBe('needs-human-review');
    expect(rejected.reasons.join('\n')).toContain('invalid Designflow resolution');
    expect(rejected.issueIds).toEqual([]);
    expect(rejected.capabilityCoverage).toEqual([]);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.db.counters.ISSUE).toBe(issueCounterBefore);
    expect(consumerCalls).toBe(0);
    expect(reconcilerCalls).toBe(0);
  });

  it('resumes an awaiting Design Request through an injected consumer without rerunning planning', async () => {
    const { root } = createRoot();
    const firstStore = new Store(root);
    const intakeKey = addClaimedIntake(firstStore);
    const turnConfig = config(true);
    const issueRunner: GithubIssueRunner = {
      listReadyIssues: () => [],
      claimIssue: () => {
        throw new Error('the already-claimed intake must not be claimed again');
      },
    };
    let planningCalls = 0;
    let resolverCalls = 0;
    let decisionGateCalls = 0;
    let capabilityReconcilerCalls = 0;
    const designflowEvents: string[] = [];
    const queues: string[][] = [[]];
    const planningRunner = async ({ route }: {
      route: { provider: 'claude' | 'codex' | 'gemini' | 'mock'; model: string | null };
    }) => {
      planningCalls += 1;
      return {
        provider: route.provider,
        model: route.model,
        prompt: 'draft UI requirements',
        outcome: 'completed' as const,
        output: { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      };
    };
    const planningInvocation = recordAgentInvocation(firstStore, {
      subjectId: intakeKey,
      attempt: 1,
      role: 'issue-planner',
      perspective: null,
      provider: 'claude',
      model: 'opus',
      prompt: 'durable draft before restart',
      outcome: 'completed',
    });
    applyPlanningEnrichment(
      firstStore,
      turnConfig,
      intakeKey,
      { candidates: [], designDrafts: [designDraft()], ambiguities: [] },
      {
        systemDir: path.join(root, 'docs', '_system'),
        invocationKey: planningInvocation.invocationKey,
      },
    );
    expect(firstStore.intakeByKey(intakeKey)?.status).toBe('design-pending');
    expect(firstStore.db.issues).toEqual([]);

    const restarted = new Store(root);
    let resolvedRequest: DesignRequest | null = null;
    const designflowResolver = async ({ designRequest }: { designRequest: DesignRequest }) => {
      resolverCalls += 1;
      resolvedRequest = designRequest;
      return {
        bundle: {
          bundleRoot: '/provider/candidate',
          manifestPath: 'manifest.json',
          designRequestPath: 'request.json',
          humanDecisionPath: 'decision.json',
        },
      };
    };
    const designflowConsumer = {
      validateBundle() {
        designflowEvents.push('consume');
        if (!resolvedRequest) throw new Error('resolver did not supply the Design Request');
        return approvedContract(resolvedRequest);
      },
    };
    const designflowDecisionGate = () => {
      decisionGateCalls += 1;
      designflowEvents.push('gate');
      if (!resolvedRequest) throw new Error('resolver did not supply the Design Request');
      return approvedDecisionGate(approvedContract(resolvedRequest));
    };
    const designflowCapabilityReconciler = async ({
      approvedContract: contract,
    }: {
      approvedContract: DesignflowContractResult;
    }) => {
      capabilityReconcilerCalls += 1;
      designflowEvents.push('reconcile');
      return capabilityReconciliation(contract);
    };
    const resumedDeps = {
      issueRunner,
      planningRunner,
      designflowResolver,
      designflowCapabilityReconciler,
      designflowConsumer,
      designflowDecisionGate,
      designflowReviewProjector: () => {
        if (!resolvedRequest) throw new Error('resolver did not supply the Design Request');
        return approvedReview(approvedContract(resolvedRequest));
      },
      driveQueue: async () => {
        queues.push(pollable(restarted, turnConfig).map((issue) => issue.id));
        return [];
      },
    };
    await runGithubDevelopmentTurn(restarted, turnConfig, resumedDeps, root);
    await runGithubDevelopmentTurn(restarted, turnConfig, resumedDeps, root);

    expect(planningCalls).toBe(0);
    expect(resolverCalls).toBe(1);
    expect(decisionGateCalls).toBe(1);
    expect(capabilityReconcilerCalls).toBe(1);
    expect(designflowEvents).toEqual(['gate', 'consume', 'reconcile']);
    expect(queues).toEqual([
      [],
      ['ISSUE-0001'],
      ['ISSUE-0001'],
    ]);
    expect(restarted.db.planningEnrichments).toHaveLength(1);
    expect(restarted.db.issues).toHaveLength(2);
    expect(restarted.db.issues[1]).toMatchObject({
      planningCandidateKey: 'ui-export',
      designRequestId: resolvedRequest!.requestId,
      status: 'contract-drafted',
      dependsOnIssues: [restarted.db.issues[0]!.id],
    });
  });
});
