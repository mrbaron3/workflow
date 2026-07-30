type JsonObject = Record<string, any>;

function same(
  errors: string[],
  path: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) errors.push(`${path} must equal its bound value`);
}

function validArtifactPath(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  const path = uri.startsWith('evidence/live-release/')
    ? uri.slice('evidence/live-release/'.length)
    : uri.startsWith('volume://registrations/')
      ? uri.slice('volume://registrations/'.length)
      : '';
  return path.length > 0
    && path.split('/').every((segment) => (
      segment !== '.'
      && segment !== '..'
      && segment.length > 0
      && !segment.startsWith('.')
    ));
}

function roundHasFindings(round: JsonObject | undefined): boolean {
  return (round?.reviewers ?? []).some(
    (reviewer: JsonObject) => reviewer?.verdict === 'findings',
  );
}

/**
 * JSON Schema proves the evidence shape and the individual invariants. This
 * validator binds independently observed sections to one release revision, one
 * external target, and one intervention account, so sections collected from
 * different runs cannot be assembled into a passing artifact.
 */
export function liveReleaseSemanticErrors(evidence: JsonObject): string[] {
  const errors: string[] = [];
  const finalHead = evidence.execution?.finalHead;

  // The target must be external to the harness that drove the run. A cutover
  // that bootstraps itself proves the pipeline works on its own repository,
  // which is the property this evidence exists to distinguish itself from.
  if (
    evidence.consumer?.repository
    && evidence.consumer.repository === evidence.target?.repository
  ) {
    errors.push('consumer.repository must differ from target.repository');
  }
  const monitored: unknown[] = evidence.target?.monitoredRepositories ?? [];
  if (!monitored.includes(evidence.target?.repository)) {
    errors.push('target.repository must appear in target.monitoredRepositories');
  }

  // Every head that claims to be the released revision must be the same commit.
  // `expectedHead` included: the merge fence has to have been computed against
  // the revision that was actually released, not an earlier one.
  for (const [path, value] of [
    ['execution.expectedHead', evidence.execution?.expectedHead],
    ['github.finalPrHead', evidence.github?.finalPrHead],
    ['formalReviews.round2.head', evidence.formalReviews?.round2?.head],
  ] as const) {
    same(errors, path, value, finalHead);
  }

  const round1 = evidence.formalReviews?.round1;
  const round2 = evidence.formalReviews?.round2;
  for (const [name, round] of Object.entries<JsonObject>({ round1, round2 })) {
    if (!round) continue;
    for (const [index, reviewer] of (round.reviewers ?? []).entries()) {
      same(
        errors,
        `formalReviews.${name}.reviewers.${index}.head`,
        reviewer?.head,
        round.head,
      );
      const noFindings = reviewer?.verdict === 'no_findings';
      if (noFindings !== (reviewer?.findingCount === 0)) {
        errors.push(
          `formalReviews.${name}.reviewers.${index}.verdict must agree with findingCount`,
        );
      }
    }
    const agents = (round.reviewers ?? []).map((r: JsonObject) => r?.agent);
    if (new Set(agents).size !== agents.length) {
      errors.push(`formalReviews.${name}.reviewers must be distinct agents`);
    }
  }
  // A round that found something must have been answered by a new commit.
  // Without this, "2 rounds" can be two reads of the same unchanged revision.
  if (round1 && round2 && roundHasFindings(round1) && round1.head === round2.head) {
    errors.push('formalReviews.round2.head must advance past a round1 with findings');
  }

  // Labels: the human gate and the automation claim cannot be the same label,
  // and triage must never have written either of them.
  const readyLabel = evidence.triage?.humanReadyLabel;
  const claimedLabel = evidence.triage?.claimedLabel;
  if (readyLabel && readyLabel === claimedLabel) {
    errors.push('triage.humanReadyLabel must differ from triage.claimedLabel');
  }
  for (const [index, label] of (evidence.triage?.managedLabelsApplied ?? []).entries()) {
    if (label === readyLabel || label === claimedLabel) {
      errors.push(
        `triage.managedLabelsApplied.${index} must not be the ready or claimed label`,
      );
    }
  }

  // Provider invocations account for distinct calls, and the two roles this
  // chain cannot have skipped must both appear.
  const invocations: JsonObject[] = evidence.providerInvocations ?? [];
  const keys = invocations.map((invocation) => invocation?.invocationKey);
  if (new Set(keys).size !== keys.length) {
    errors.push('providerInvocations.invocationKey must be unique');
  }
  for (const role of ['triage', 'generator']) {
    if (!invocations.some((invocation) => invocation?.role === role)) {
      errors.push(`providerInvocations must record at least one ${role} invocation`);
    }
  }
  // Each call must name the job it served. Without this the array is unsourced
  // free text: invocations from another issue or run would satisfy the role and
  // uniqueness rules while proving nothing about this release.
  for (const [index, invocation] of invocations.entries()) {
    const expectedJobId = invocation?.role === 'triage'
      ? evidence.triage?.promotionJobId
      : evidence.execution?.jobId;
    same(
      errors,
      `providerInvocations.${index}.jobId`,
      invocation?.jobId,
      expectedJobId,
    );
  }

  // The two design sections describe one fact from two sides, so they apply
  // together or not at all. Letting them disagree admits a release carrying an
  // approved bundle with no verified lineage, and a lineage that skips binding
  // to the bundle it claims to descend from.
  const bundle = evidence.designBundle;
  const lineage = evidence.releaseLineage;
  if (bundle?.applicable !== lineage?.applicable) {
    errors.push(
      'designBundle.applicable and releaseLineage.applicable must agree',
    );
  } else if (bundle?.applicable === true) {
    same(errors, 'releaseLineage.bundleDigest', lineage.bundleDigest, bundle.bundleDigest);
    same(errors, 'releaseLineage.headSha', lineage.headSha, finalHead);
  }

  const interventions = evidence.howInterventions;
  const count = interventions?.count;
  const records: unknown[] = interventions?.records ?? [];
  if (count !== records.length) {
    errors.push('howInterventions.count must equal howInterventions.records length');
  }
  // The result is a reading of the intervention account, not an independent
  // claim: a run cannot report interventions and still call itself clean.
  const expectedResult = count === 0 ? 'passed' : 'passed-with-interventions';
  same(errors, 'result', evidence.result, expectedResult);

  for (const [index, artifact] of (evidence.artifacts ?? []).entries()) {
    same(errors, `artifacts.${index}.sourceHead`, artifact.sourceHead, finalHead);
    if (!validArtifactPath(artifact.uri)) {
      errors.push(`artifacts.${index}.uri must not contain dot/empty segments`);
    }
  }

  return errors;
}

export function assertLiveReleaseSemanticEvidence(evidence: JsonObject): void {
  const errors = liveReleaseSemanticErrors(evidence);
  if (errors.length > 0) {
    throw new Error(`live release evidence semantics failed: ${errors.join('; ')}`);
  }
}
