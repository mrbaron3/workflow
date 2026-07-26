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
  const path = uri.startsWith('evidence/ciso-07/')
    ? uri.slice('evidence/ciso-07/'.length)
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

function exactMounts(
  errors: string[],
  role: string,
  mounts: unknown,
  expected: Record<string, { type: string; name?: string; readOnly: boolean }>,
): void {
  if (!Array.isArray(mounts)) return;
  const byDestination = new Map(
    mounts.map((mount: JsonObject) => [mount.destination, mount]),
  );
  if (
    byDestination.size !== mounts.length
    || byDestination.size !== Object.keys(expected).length
  ) {
    errors.push(`topology.${role}.mounts must be the exact role mount set`);
    return;
  }
  for (const [destination, shape] of Object.entries(expected)) {
    const mount = byDestination.get(destination);
    if (
      !mount
      || mount.type !== shape.type
      || mount.readOnly !== shape.readOnly
      || ('name' in shape && mount.name !== shape.name)
      || (!('name' in shape) && mount.name != null)
    ) {
      errors.push(`topology.${role}.mounts has an invalid ${destination} mount`);
    }
  }
}

/**
 * JSON Schema proves the evidence shape. This validator binds independently
 * observed sections to one release revision and one durable runtime lineage.
 */
export function ciso07SemanticErrors(evidence: JsonObject): string[] {
  const errors: string[] = [];
  const finalHead = evidence.source?.finalHead;
  for (const role of ['control', 'runner', 'postgres']) {
    same(
      errors,
      `images.${role}.sourceHead`,
      evidence.images?.[role]?.sourceHead,
      finalHead,
    );
    same(
      errors,
      `topology.${role}.imageDigest`,
      evidence.topology?.[role]?.imageDigest,
      evidence.images?.[role]?.digest,
    );
    same(
      errors,
      `topology.${role}.name`,
      evidence.topology?.[role]?.name,
      `agentops-ciso07-dogfood-${role}`,
    );
  }
  for (const [path, value] of [
    ['execution.expectedHead', evidence.execution?.expectedHead],
    ['execution.finalHead', evidence.execution?.finalHead],
    ['github.finalPrHead', evidence.github?.finalPrHead],
  ] as const) {
    same(errors, path, value, finalHead);
  }
  for (const [index, artifact] of (evidence.artifacts ?? []).entries()) {
    same(errors, `artifacts.${index}.sourceHead`, artifact.sourceHead, finalHead);
    if (!validArtifactPath(artifact.uri)) {
      errors.push(`artifacts.${index}.uri must not contain dot/empty segments`);
    }
  }

  const reviews = evidence.formalReviews;
  for (const [roundName, round] of Object.entries<JsonObject>({
    round1: reviews?.round1,
    round2: reviews?.round2,
  })) {
    if (!round) continue;
    for (const agent of ['codex', 'claude']) {
      same(
        errors,
        `formalReviews.${roundName}.${agent}.agent`,
        round[agent]?.agent,
        agent,
      );
      same(
        errors,
        `formalReviews.${roundName}.${agent}.head`,
        round[agent]?.head,
        round.head,
      );
      const noFindings = round[agent]?.verdict === 'no_findings';
      if (noFindings !== (round[agent]?.findingCount === 0)) {
        errors.push(
          `formalReviews.${roundName}.${agent} verdict/count is incoherent`,
        );
      }
    }
  }
  same(
    errors,
    'formalReviews.round1.head',
    reviews?.round1?.head,
    evidence.source?.initialHead,
  );

  const draining = Date.parse(evidence.recovery?.drainingAt ?? '');
  const off = Date.parse(evidence.recovery?.offAt ?? '');
  const restarted = Date.parse(evidence.recovery?.restartedAt ?? '');
  if (
    !Number.isFinite(draining)
    || !Number.isFinite(off)
    || !Number.isFinite(restarted)
    || draining > off
    || off > restarted
  ) {
    errors.push('recovery timestamps must be ordered DRAINING <= OFF <= restart');
  }
  same(
    errors,
    'recovery.registrationId',
    evidence.recovery?.registrationId,
    evidence.registration?.id,
  );
  same(
    errors,
    'recovery.registrationVersion',
    evidence.recovery?.registrationVersion,
    evidence.registration?.version,
  );
  same(
    errors,
    'execution.registrationVersion',
    evidence.execution?.registrationVersion,
    evidence.registration?.version,
  );
  same(
    errors,
    'recovery.cursorDigestAfter',
    evidence.recovery?.cursorDigestAfter,
    evidence.recovery?.cursorDigestBefore,
  );
  for (const field of ['jobId', 'attemptId', 'leaseId']) {
    same(
      errors,
      `recovery.${field}`,
      evidence.recovery?.[field],
      evidence.execution?.[field],
    );
  }

  const artifactKinds = new Set(
    (evidence.artifacts ?? []).map((artifact: JsonObject) => artifact.kind),
  );
  for (const kind of [
    'validation-report',
    'image-scan',
    'github-current-state',
  ]) {
    if (!artifactKinds.has(kind)) {
      errors.push(`artifacts must include distinct ${kind}`);
    }
  }

  exactMounts(errors, 'control', evidence.topology?.control?.mounts, {
    '/tmp': { type: 'tmpfs', readOnly: false },
  });
  exactMounts(errors, 'runner', evidence.topology?.runner?.mounts, {
    '/tmp': { type: 'tmpfs', readOnly: false },
    '/home/agentops': { type: 'tmpfs', readOnly: false },
    '/workspace': {
      type: 'volume',
      name: 'agentops-ciso07-dogfood-runner-workspace',
      readOnly: false,
    },
    '/run/agentops-credentials': {
      type: 'volume',
      name: 'agentops-ciso07-dogfood-runner-credentials',
      readOnly: true,
    },
  });
  exactMounts(errors, 'postgres', evidence.topology?.postgres?.mounts, {
    '/var/lib/postgresql': {
      type: 'volume',
      name: 'agentops-ciso07-dogfood-postgres-data',
      readOnly: false,
    },
    '/run/postgresql': { type: 'tmpfs', readOnly: false },
    '/tmp': { type: 'tmpfs', readOnly: false },
  });
  return errors;
}

export function assertCiso07SemanticEvidence(evidence: JsonObject): void {
  const errors = ciso07SemanticErrors(evidence);
  if (errors.length !== 0) {
    throw new Error(`CISO-07 evidence is semantically invalid:\n${errors.join('\n')}`);
  }
}
