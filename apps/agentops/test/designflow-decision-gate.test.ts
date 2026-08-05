import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeDesignflowArtifactDigest,
  computeDesignflowBundleDigest,
  DesignBundleManifestSchema,
  evaluateDesignDecisionGate,
  evaluateMaterializedDesignDecisionGate,
  HumanDesignDecisionSchema,
  type DesignBundleManifest,
  type DesignDecisionGateInput,
  type DesignDecisionGateReasonCode,
  type HumanDesignDecision,
} from '../src/designflow/decision-gate.js';

const REPOSITORY_ROOT = resolve(process.cwd());
const CONTRACT_ROOT = resolve(
  REPOSITORY_ROOT,
  'contracts/designflow/contract-v1.0.0-rc.1',
);
const CONTRACT_EXAMPLES = resolve(CONTRACT_ROOT, 'contracts/v1/examples');

interface LoadedCandidate extends DesignDecisionGateInput {
  manifest: DesignBundleManifest;
  source: Buffer;
  artifacts: Record<string, Buffer>;
  decision: HumanDesignDecision;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadCandidate(
  artifactRoot: string,
  manifestPath: string,
  sourcePath: string,
  decisionPath: string,
): LoadedCandidate {
  const manifest = DesignBundleManifestSchema.parse(readJson(manifestPath));
  const artifacts: Record<string, Buffer> = {};
  for (const reference of Object.values(manifest.artifacts)) {
    if (reference !== undefined) {
      artifacts[reference.path] = readFileSync(resolve(artifactRoot, reference.path));
    }
  }
  return {
    manifest,
    source: readFileSync(sourcePath),
    artifacts,
    decision: HumanDesignDecisionSchema.parse(readJson(decisionPath)),
  };
}

function contractCandidate(): LoadedCandidate {
  return loadCandidate(
    CONTRACT_ROOT,
    resolve(CONTRACT_EXAMPLES, 'design-bundle-manifest.example.json'),
    resolve(CONTRACT_EXAMPLES, 'design-request.example.json'),
    resolve(CONTRACT_EXAMPLES, 'human-design-decision.example.json'),
  );
}

function cisoCandidate(): LoadedCandidate {
  return loadCandidate(
    REPOSITORY_ROOT,
    resolve(
      REPOSITORY_ROOT,
      'evidence/ciso-05/design/revision-02/design-bundle-manifest.json',
    ),
    resolve(REPOSITORY_ROOT, 'evidence/ciso-05/design/design-request.json'),
    resolve(REPOSITORY_ROOT, 'evidence/ciso-05/design/decisions/approve-r02.json'),
  );
}

function reasonCodes(result: ReturnType<typeof evaluateDesignDecisionGate>) {
  return result.reasons.map((reason) => reason.code);
}

function mutateJsonArtifact(
  candidate: LoadedCandidate,
  artifactKey: keyof DesignBundleManifest['artifacts'],
  mutate: (document: Record<string, unknown>) => void,
  rebind: boolean,
): LoadedCandidate {
  const manifest = structuredClone(candidate.manifest);
  const decision = structuredClone(candidate.decision);
  const artifacts = { ...candidate.artifacts };
  const reference = manifest.artifacts[artifactKey];
  if (reference === undefined) {
    throw new Error(`fixture has no ${artifactKey}`);
  }
  const document = readArtifactObject(artifacts[reference.path]);
  mutate(document);
  const content = Buffer.from(JSON.stringify(document));
  artifacts[reference.path] = content;

  if (rebind) {
    reference.digest = computeDesignflowArtifactDigest(content, reference.mediaType);
    manifest.bundleDigest = computeDesignflowBundleDigest(manifest);
    decision.bundleDigest = manifest.bundleDigest;
  }
  return {
    manifest,
    source: candidate.source,
    artifacts,
    decision,
  };
}

function readArtifactObject(content: Buffer | undefined): Record<string, unknown> {
  if (content === undefined) {
    throw new Error('fixture artifact is missing');
  }
  const value = JSON.parse(content.toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture artifact is not an object');
  }
  return value as Record<string, unknown>;
}

function expectReason(
  result: ReturnType<typeof evaluateDesignDecisionGate>,
  code: DesignDecisionGateReasonCode,
): void {
  expect(result.status).toBe('needs-human-review');
  expect(reasonCodes(result)).toContain(code);
}

describe('Designflow digest-bound Human Design Decision gate', () => {
  it('recomputes the pinned RFC 8785 source, artifact, and bundle digest fixture', () => {
    const candidate = contractCandidate();

    expect(computeDesignflowArtifactDigest(candidate.source, 'application/json'))
      .toBe(candidate.manifest.sourceDigest);
    for (const reference of Object.values(candidate.manifest.artifacts)) {
      if (reference === undefined) {
        continue;
      }
      expect(
        computeDesignflowArtifactDigest(
          candidate.artifacts[reference.path]!,
          reference.mediaType,
        ),
      ).toBe(reference.digest);
    }
    expect(computeDesignflowBundleDigest(candidate.manifest))
      .toBe('sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97');

    expect(evaluateDesignDecisionGate(candidate)).toEqual({
      status: 'approved',
      requestId: 'design-dashboard-001',
      revisionId: 'design-revision-001',
      bundleDigest: 'sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97',
      decisionId: 'design-decision-001',
      supersedesDecisionId: null,
      reasons: [],
    });
  });

  it('replays the approved CISO bundle without a compiled digest or CISO path in the gate', () => {
    const candidate = cisoCandidate();

    expect(evaluateDesignDecisionGate(candidate)).toEqual({
      status: 'approved',
      requestId: 'workflow-ciso05-dashboard-20260726',
      revisionId: 'workflow-ciso05-dashboard-r02',
      bundleDigest: 'sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa',
      decisionId: 'workflow-ciso05-dashboard-r02-approve',
      supersedesDecisionId: 'workflow-ciso05-dashboard-r01-request-changes',
      reasons: [],
    });
  });

  it('materializes the runtime bundle paths and evaluates the same raw decision input', () => {
    const materialized = evaluateMaterializedDesignDecisionGate({
      bundleRoot: CONTRACT_ROOT,
      manifestPath: 'contracts/v1/examples/design-bundle-manifest.example.json',
      designRequestPath: 'contracts/v1/examples/design-request.example.json',
      humanDecisionPath: 'contracts/v1/examples/human-design-decision.example.json',
    });

    expect(materialized).toEqual(evaluateDesignDecisionGate(contractCandidate()));
    expect(materialized.status).toBe('approved');
  });

  it.each([
    ['requestId', 'different-request'],
    ['revisionId', 'different-revision'],
    ['bundleDigest', `sha256:${'0'.repeat(64)}`],
  ] as const)(
    'fails closed when approval %s is stale',
    (field, value) => {
      const candidate = contractCandidate();
      candidate.decision[field] = value;

      const result = evaluateDesignDecisionGate(candidate);

      expectReason(result, 'stale-approval');
      expect(result.reasons.find((reason) => reason.code === 'stale-approval')?.message)
        .toContain(field);
    },
  );

  it.each([
    ['request-changes', 'decision-request-changes'],
    ['reject', 'decision-rejected'],
  ] as const)(
    'projects a %s verdict to needs-human-review',
    (verdict, reason) => {
      const candidate = contractCandidate();
      candidate.decision.verdict = verdict;

      expectReason(evaluateDesignDecisionGate(candidate), reason);
    },
  );

  it('fails closed when the Human Design Decision is missing', () => {
    const candidate = contractCandidate();

    expectReason(
      evaluateDesignDecisionGate({ ...candidate, decision: null }),
      'decision-missing',
    );
  });

  it('rejects a schema-valid artifact mutation even though its JSON still validates', () => {
    const candidate = mutateJsonArtifact(
      contractCandidate(),
      'experience',
      (document) => {
        const purposes = document.pagePurposes as Array<Record<string, unknown>>;
        purposes[0]!.successOutcome = 'schema-valid but unapproved replacement outcome';
      },
      false,
    );

    const result = evaluateDesignDecisionGate(candidate);

    expectReason(result, 'artifact-digest-mismatch');
    expect(reasonCodes(result)).not.toContain('artifact-schema-invalid');
  });

  it('rejects unresolved ambiguity even when artifact, bundle, and approval are rebound', () => {
    const candidate = mutateJsonArtifact(
      contractCandidate(),
      'experience',
      (document) => {
        document.ambiguities = ['operator recovery behavior remains unresolved'];
      },
      true,
    );

    const result = evaluateDesignDecisionGate(candidate);

    expect(result.status).toBe('needs-human-review');
    expect(reasonCodes(result)).toEqual(['unresolved-ambiguity']);
  });

  it('validates artifact JSON Schema independently of digest consistency', () => {
    const candidate = mutateJsonArtifact(
      contractCandidate(),
      'capabilityRequirements',
      (document) => {
        document.unpublishedField = true;
      },
      true,
    );

    const result = evaluateDesignDecisionGate(candidate);

    expectReason(result, 'artifact-schema-invalid');
    expect(reasonCodes(result)).not.toContain('artifact-digest-mismatch');
    expect(reasonCodes(result)).not.toContain('bundle-digest-mismatch');
    expect(reasonCodes(result)).not.toContain('stale-approval');
  });

  it('rejects a manifest mutation whose claimed bundleDigest was not recomputed', () => {
    const candidate = contractCandidate();
    candidate.manifest.createdAt = '2026-07-25T03:31:00.000Z';

    const result = evaluateDesignDecisionGate(candidate);

    expectReason(result, 'bundle-digest-mismatch');
    expect(result.decisionId).toBe(candidate.decision.decisionId);
  });

  it('returns byte-for-byte deterministic fail-closed results', () => {
    const candidate = contractCandidate();
    candidate.decision.revisionId = 'stale-revision';
    const first = JSON.stringify(evaluateDesignDecisionGate(candidate));
    const second = JSON.stringify(evaluateDesignDecisionGate(candidate));

    expect(second).toBe(first);
  });
});
