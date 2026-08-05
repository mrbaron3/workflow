import type { Store } from '../store/store.js';
import { digestDesignflowArtifact } from './contract-consumer.js';

export const DESIGNFLOW_RELEASE_LINEAGE_REASON_CODES = [
  'intake-missing',
  'planning-not-accepted',
  'design-request-missing',
  'source-lineage-mismatch',
  'approval-missing',
  'decision-cycle-missing',
  'revision-cycle-mismatch',
  'issue-lineage-mismatch',
  'capability-coverage-mismatch',
  'pr-lineage-mismatch',
  'revision-lineage-mismatch',
  'gate-lineage-mismatch',
  'playwright-evidence-missing',
  'ux-evidence-missing',
  'accessibility-evidence-missing',
  'release-missing',
] as const;

export type DesignflowReleaseLineageReasonCode =
  (typeof DESIGNFLOW_RELEASE_LINEAGE_REASON_CODES)[number];

export interface DesignflowReleaseLineageReason {
  readonly code: DesignflowReleaseLineageReasonCode;
  readonly message: string;
}

export interface DesignflowReleaseLineageInput {
  readonly intakeKey: string;
  readonly candidateKey: string;
  /** Grounded acceptance may require an observed change request before approval. */
  readonly requireRequestChanges?: boolean;
}

export interface VerifiedDesignflowReleaseLineage {
  readonly status: 'verified';
  readonly intakeKey: string;
  readonly candidateKey: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly bundleDigest: string;
  readonly capabilityIds: readonly string[];
  readonly issueId: string;
  readonly prId: string;
  readonly prRevisionId: string;
  readonly headSha: string;
  readonly evidenceRunIds: Readonly<{
    playwright: string;
    ux: string;
    accessibility: string;
  }>;
  readonly reasons: readonly [];
}

export interface UnverifiedDesignflowReleaseLineage {
  readonly status: 'needs-human-review';
  readonly intakeKey: string;
  readonly candidateKey: string;
  readonly reasons: readonly DesignflowReleaseLineageReason[];
}

export type DesignflowReleaseLineageResult =
  | VerifiedDesignflowReleaseLineage
  | UnverifiedDesignflowReleaseLineage;

type StoreDb = Store['db'];

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezeResult<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      freezeResult(nested);
    }
  }
  return Object.freeze(value);
}

/**
 * Join the complete locally-observable Designflow release chain. Every mismatch is reported
 * deterministically and the caller receives no partial "verified" projection.
 */
export function evaluateDesignflowReleaseLineage(
  db: StoreDb,
  input: DesignflowReleaseLineageInput,
): DesignflowReleaseLineageResult {
  const reasons: DesignflowReleaseLineageReason[] = [];
  const add = (code: DesignflowReleaseLineageReasonCode, message: string): void => {
    if (!reasons.some((reason) => reason.code === code && reason.message === message)) {
      reasons.push({ code, message });
    }
  };
  const fail = (): UnverifiedDesignflowReleaseLineage => freezeResult({
    status: 'needs-human-review',
    intakeKey: input.intakeKey,
    candidateKey: input.candidateKey,
    reasons,
  });

  const intake = db.intakeRecords.find((record) => record.intakeKey === input.intakeKey);
  if (!intake) {
    add('intake-missing', `No intake record exists for ${input.intakeKey}`);
    return fail();
  }
  const planning = db.planningEnrichments.find(
    (record) => record.intakeKey === input.intakeKey,
  );
  if (!planning || planning.status !== 'accepted') {
    add(
      'planning-not-accepted',
      `Planning for ${input.intakeKey} is not accepted`,
    );
    return fail();
  }
  const draft = planning.designDrafts.find(
    (candidate) => candidate.candidate.candidateKey === input.candidateKey,
  );
  if (!draft) {
    add(
      'design-request-missing',
      `No Design Request exists for candidate ${input.candidateKey}`,
    );
    return fail();
  }
  const providerSelections = planning.designProviderSelections.filter(
    (selection) => selection.candidateKey === input.candidateKey,
  );
  if (
    providerSelections.length !== 1
    || providerSelections[0]?.provider !== 'designflow'
  ) {
    add(
      'design-request-missing',
      `Candidate ${input.candidateKey} has no exclusive Designflow provider selection`,
    );
  }
  const request = draft.designRequest;
  const expectedSnapshotDigest = digestDesignflowArtifact(
    Buffer.from(JSON.stringify(intake.snapshot), 'utf8'),
    'application/json',
  );
  if (
    request.sourceRef.provider !== 'github'
    || request.sourceRef.externalId
      !== `${intake.snapshot.repository}#${intake.snapshot.number}`
    || request.sourceRef.uri !== intake.snapshot.url
    || request.sourceRef.revision !== intake.snapshot.sourceUpdatedAt
    || request.sourceRef.digest !== expectedSnapshotDigest
  ) {
    add(
      'source-lineage-mismatch',
      'Design Request sourceRef does not match the immutable GitHub intake snapshot',
    );
  }

  const approvedCandidates = planning.approvedDesigns.filter(
    (design) => design.candidateKey === input.candidateKey,
  );
  const approved = approvedCandidates.length === 1
    ? approvedCandidates[0]
    : undefined;
  if (!approved || approved.reviewProjection === null || approved.decisionId === null) {
    add(
      'approval-missing',
      `Candidate ${input.candidateKey} has no complete approved Designflow revision`,
    );
    return fail();
  }
  const review = approved.reviewProjection;
  const expectedRequestDigest = digestDesignflowArtifact(
    Buffer.from(JSON.stringify(request), 'utf8'),
    'application/json',
  );
  if (
    approved.requestId !== request.requestId
    || review.identity.requestId !== approved.requestId
    || review.identity.revisionId !== approved.revisionId
    || review.digest.sourceDigest !== expectedRequestDigest
    || review.digest.bundleDigest !== approved.bundleDigest
    || review.ambiguities.length !== 0
  ) {
    add(
      'approval-missing',
      'Approved design identity or digest does not match its Design Request and review projection',
    );
  }

  const candidateDecisions = planning.designDecisionHistory.filter(
    (decision) => decision.candidateKey === input.candidateKey,
  );
  const approvedDecision = [...candidateDecisions].reverse().find(
    (decision) =>
      decision.outcome === 'approve'
      && decision.requestId === approved.requestId
      && decision.revisionId === approved.revisionId
      && decision.bundleDigest === approved.bundleDigest
      && decision.decisionId === approved.decisionId,
  );
  if (!approvedDecision) {
    add(
      'approval-missing',
      'Approved revision is absent from the append-only human decision history',
    );
  }
  if (input.requireRequestChanges) {
    const requested = candidateDecisions.filter(
      (decision) =>
        decision.outcome === 'request-changes'
        && decision.requestId === approved.requestId,
    );
    if (requested.length === 0) {
      add(
        'decision-cycle-missing',
        'No request-changes decision precedes the approved revision',
      );
    } else {
      const latest = requested.at(-1)!;
      if (
        latest.revisionId === null
        || latest.decisionId === null
        || latest.revisionId === approved.revisionId
        || review.identity.previousRevisionId !== latest.revisionId
        || approvedDecision?.supersedesDecisionId !== latest.decisionId
      ) {
        add(
          'revision-cycle-mismatch',
          'Approved revision does not directly supersede the latest request-changes decision',
        );
      }
    }
  }

  const issues = db.issues.filter(
    (candidate) =>
      planning.issueIds.includes(candidate.id)
      && candidate.planningCandidateKey === input.candidateKey,
  );
  const issue = issues.length === 1 ? issues[0] : undefined;
  if (
    !issue
    || issue.designAuthority?.provider !== 'designflow'
    || issue.designAuthority.requestId !== approved.requestId
    || issue.designAuthority.revisionId !== approved.revisionId
    || issue.designAuthority.bundleDigest !== approved.bundleDigest
    || issue.designAuthority.decisionId !== approved.decisionId
    || issue.designReview === null
  ) {
    add(
      'issue-lineage-mismatch',
      `Candidate ${input.candidateKey} has no Issue bound to the approved design authority`,
    );
    return fail();
  }

  const projectedCapabilityIds = uniqueSorted(
    review.capabilityDelta.flatMap((capability) =>
      typeof capability.id === 'string' ? [capability.id] : []),
  );
  const coverage = planning.capabilityCoverage.filter(
    (edge) => projectedCapabilityIds.includes(edge.capabilityId),
  );
  const coveredCapabilityIds = uniqueSorted(coverage.map((edge) => edge.capabilityId));
  const issueCapabilityIds = uniqueSorted(
    coverage
      .filter((edge) => edge.issueId === issue.id)
      .map((edge) => edge.capabilityId),
  );
  const planningIssues = db.issues.filter((candidate) =>
    planning.issueIds.includes(candidate.id));
  const availableApiOperations = new Set(planningIssues.flatMap((candidate) =>
    candidate.contract?.apiOperations?.map((operation) => operation.operationId) ?? []));
  if (
    projectedCapabilityIds.length === 0
    || projectedCapabilityIds.join('\0') !== coveredCapabilityIds.join('\0')
    || uniqueSorted(issue.designCapabilityIds).join('\0') !== issueCapabilityIds.join('\0')
    || coverage.some((edge) => {
      const target = planningIssues.find((candidate) => candidate.id === edge.issueId);
      const criterionIds = new Set(
        target?.contract?.acceptanceCriteria.map((criterion) => criterion.id) ?? [],
      );
      const systemIds = new Set(target?.dependsOnSystem ?? []);
      return edge.requestId !== approved.requestId
        || edge.revisionId !== approved.revisionId
        || edge.bundleDigest !== approved.bundleDigest
        || !target
        || !criterionIds.has(edge.criterionId)
        || !target.designCapabilityIds.includes(edge.capabilityId)
        || target.designAuthority?.provider !== 'designflow'
        || target.designAuthority.requestId !== approved.requestId
        || target.designAuthority.revisionId !== approved.revisionId
        || target.designAuthority.bundleDigest !== approved.bundleDigest
        || edge.systemElementIds.some((elementId) => !systemIds.has(elementId))
        || edge.apiOperationIds.some((operationId) =>
          !availableApiOperations.has(operationId));
    })
  ) {
    add(
      'capability-coverage-mismatch',
      'Capability coverage is incomplete or does not resolve to real Issue/AC/system/API edges',
    );
  }
  const capabilityIssueIds = uniqueSorted(coverage.map((edge) => edge.issueId));
  for (const capabilityIssueId of capabilityIssueIds) {
    const capabilityIssue = planningIssues.find(
      (candidate) => candidate.id === capabilityIssueId,
    );
    if (!capabilityIssue) continue;
    if (capabilityIssue.status !== 'released') {
      add('release-missing', `Capability Issue ${capabilityIssueId} is not released`);
    }

    const capabilityPrs = db.prs.filter(
      (candidate) => candidate.issueId === capabilityIssueId,
    );
    const capabilityPr = capabilityPrs.length === 1 ? capabilityPrs[0] : undefined;
    if (
      !capabilityPr
      || capabilityPr.status !== 'merged'
      || capabilityPr.currentRevisionId === null
      || capabilityPr.headSha === null
      || capabilityPr.mergedHeadSha !== capabilityPr.headSha
    ) {
      add(
        'pr-lineage-mismatch',
        `Capability Issue ${capabilityIssueId} has no unique merged PR at its current head`,
      );
      continue;
    }

    const capabilityRevision = db.prRevisions.find(
      (candidate) =>
        candidate.id === capabilityPr.currentRevisionId
        && candidate.prId === capabilityPr.id
        && candidate.headSha === capabilityPr.headSha,
    );
    if (!capabilityRevision || capabilityRevision.status !== 'merged') {
      add(
        'revision-lineage-mismatch',
        `Capability PR ${capabilityPr.id} has no merged current revision `
        + `for ${capabilityPr.headSha}`,
      );
    }
    const capabilityGate = [...db.revisionGateSnapshots].reverse().find(
      (snapshot) =>
        snapshot.prId === capabilityPr.id
        && snapshot.revisionId === capabilityPr.currentRevisionId
        && snapshot.headSha === capabilityPr.headSha
        && snapshot.decision === 'approved',
    );
    if (!capabilityGate) {
      add(
        'gate-lineage-mismatch',
        `Capability PR ${capabilityPr.id} has no approved gate at its current revision/head`,
      );
    }
  }

  const prs = db.prs.filter((candidate) => candidate.issueId === issue.id);
  const pr = prs.length === 1 ? prs[0] : undefined;
  if (
    !pr
    || pr.status !== 'merged'
    || pr.currentRevisionId === null
    || pr.headSha === null
    || pr.mergedHeadSha !== pr.headSha
  ) {
    add(
      'pr-lineage-mismatch',
      `Issue ${issue.id} has no unique merged PR bound to one immutable head`,
    );
    return fail();
  }
  const revision = db.prRevisions.find(
    (candidate) =>
      candidate.id === pr.currentRevisionId
      && candidate.prId === pr.id
      && candidate.headSha === pr.headSha,
  );
  if (!revision || revision.status !== 'merged') {
    add(
      'revision-lineage-mismatch',
      `PR ${pr.id} has no matching merged revision for ${pr.headSha}`,
    );
  }
  const approvedGate = [...db.revisionGateSnapshots].reverse().find(
    (snapshot) =>
      snapshot.prId === pr.id
      && snapshot.revisionId === pr.currentRevisionId
      && snapshot.headSha === pr.headSha
      && snapshot.decision === 'approved',
  );
  if (
    !approvedGate
    || !approvedGate.requiredPerspectives.includes('functionality')
    || !approvedGate.requiredPerspectives.includes('ux')
    || !approvedGate.requiredPerspectives.includes('accessibility')
  ) {
    add(
      'gate-lineage-mismatch',
      'Approved PR gate does not bind functionality, UX, and accessibility to the release head',
    );
  }

  const releaseRuns = db.evalRuns.filter(
    (run) =>
      run.issueId === issue.id
      && run.prId === pr.id
      && run.revisionId === pr.currentRevisionId
      && run.headSha === pr.headSha,
  );
  const playwright = releaseRuns.find(
    (run) =>
      run.perspective === 'functionality'
      && run.verdict === 'approve'
      && run.hardGates.playwright === 'pass',
  );
  const ux = releaseRuns.find(
    (run) => run.perspective === 'ux' && run.verdict === 'approve',
  );
  const accessibility = releaseRuns.find(
    (run) => run.perspective === 'accessibility' && run.verdict === 'approve',
  );
  if (!playwright) {
    add(
      'playwright-evidence-missing',
      'No passing Playwright functionality evidence is bound to the release head',
    );
  }
  if (!ux) {
    add(
      'ux-evidence-missing',
      'No approving UX evidence is bound to the release head',
    );
  }
  if (!accessibility) {
    add(
      'accessibility-evidence-missing',
      'No approving accessibility evidence is bound to the release head',
    );
  }
  if (issue.status !== 'released') {
    add('release-missing', `Issue ${issue.id} is not released`);
  }
  if (
    reasons.length > 0
    || !revision
    || !approvedGate
    || !playwright
    || !ux
    || !accessibility
  ) {
    return fail();
  }
  return freezeResult({
    status: 'verified',
    intakeKey: input.intakeKey,
    candidateKey: input.candidateKey,
    requestId: approved.requestId,
    revisionId: approved.revisionId,
    bundleDigest: approved.bundleDigest,
    capabilityIds: projectedCapabilityIds,
    issueId: issue.id,
    prId: pr.id,
    prRevisionId: revision.id,
    headSha: pr.headSha,
    evidenceRunIds: {
      playwright: playwright.id,
      ux: ux.id,
      accessibility: accessibility.id,
    },
    reasons: [] as const,
  });
}
