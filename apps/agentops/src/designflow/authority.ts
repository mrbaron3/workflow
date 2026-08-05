import {
  ApprovedDesignReviewProjection,
  DesignAuthority,
  digestLegacyUiDesignArtifact,
  type ApprovedDesignReviewProjection as ApprovedDesignReviewProjectionType,
  type DesignAuthority as DesignAuthorityType,
  type UiDesignArtifact,
} from '../domain/schema.js';

/** Content-bound identity for the retained UiDesignArtifact provider adapter. */
export function legacyDesignAuthority(
  artifact: UiDesignArtifact,
  invocationKey: string,
): Extract<DesignAuthorityType, { provider: 'legacy-ui-design' }> {
  const artifactDigest = digestLegacyUiDesignArtifact(artifact);
  return DesignAuthority.parse({
    provider: 'legacy-ui-design',
    candidateKey: artifact.candidateKey,
    revisionId: `legacy-${artifactDigest.slice('sha256:'.length)}`,
    artifactDigest,
    invocationKey,
  }) as Extract<DesignAuthorityType, { provider: 'legacy-ui-design' }>;
}

/**
 * Byte-stable prompt projection used by both implementation and PR review sessions.
 * Keeping this as one renderer prevents either side from silently reviewing another revision.
 */
export function renderDesignAuthorityProvenance(
  authority: DesignAuthorityType,
): string {
  const parsed = DesignAuthority.parse(authority);
  const common = [
    '## Authoritative Design Revision',
    `- Provider: ${parsed.provider}`,
    `- Candidate: ${parsed.candidateKey}`,
    `- Revision: ${parsed.revisionId}`,
  ];
  if (parsed.provider === 'legacy-ui-design') {
    return [
      ...common,
      `- Artifact digest: ${parsed.artifactDigest}`,
      `- UI design invocation: ${parsed.invocationKey}`,
    ].join('\n');
  }
  return [
    ...common,
    `- Contract provider: ${parsed.providerRef}`,
    `- Design Request: ${parsed.requestId}`,
    `- Bundle digest: ${parsed.bundleDigest}`,
    `- Human decision: ${parsed.decisionId}`,
  ].join('\n');
}

/** Canonical generator/reviewer handoff for one selected provider revision. */
export function renderAuthoritativeDesignContext(
  authority: DesignAuthorityType,
  review: ApprovedDesignReviewProjectionType | null,
): string {
  const parsedAuthority = DesignAuthority.parse(authority);
  const provenance = renderDesignAuthorityProvenance(parsedAuthority);
  if (parsedAuthority.provider === 'legacy-ui-design') {
    if (review !== null) {
      throw new Error('legacy UI authority cannot carry a Designflow review projection');
    }
    return provenance;
  }
  if (review === null) {
    throw new Error('Designflow authority requires an approved review projection');
  }
  const parsedReview = ApprovedDesignReviewProjection.parse(review);
  if (
    parsedReview.identity.requestId !== parsedAuthority.requestId
    || parsedReview.identity.revisionId !== parsedAuthority.revisionId
    || parsedReview.digest.bundleDigest !== parsedAuthority.bundleDigest
    || parsedReview.ambiguities.length > 0
  ) {
    throw new Error('Designflow review projection does not match the approved authority');
  }
  return [
    provenance,
    '',
    '## Approved Design Review Projection',
    '```json',
    JSON.stringify(parsedReview, null, 2),
    '```',
  ].join('\n');
}
