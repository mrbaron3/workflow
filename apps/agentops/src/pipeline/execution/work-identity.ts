import { createHash } from 'node:crypto';

/**
 * Durable external mutation identity for one planned work unit. Internal Store
 * counters such as ISSUE-0001 are deliberately absent: a fresh job-local Store
 * may allocate the same display id for unrelated GitHub Issues.
 */
export interface ExternalWorkIdentity {
  repository: string;
  issueNumber: number;
  intakeKey: string;
  workUnitKey: string;
  releaseId: string | null;
}

/** Identity projected into a branch/PR for one best-of-N sample. */
export interface ProjectedWorkIdentity extends ExternalWorkIdentity {
  sampleIndex: number;
}

export interface PullRequestClosingTarget {
  relation: 'Closes' | 'Refs';
  repository: string;
  issueNumber: number;
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const IDENTITY_MARKER = /^<!-- agentops-work-identity-v1 ([A-Za-z0-9_-]+) -->$/gm;
const CLOSING_TARGET = /^(Closes|Refs) ([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)\s*$/gm;
const CLOSING_DIRECTIVE = /^(?:Closes|Refs)\s+.+$/gm;

/** GitHub repository names are case-insensitive; use one comparison form everywhere. */
export function canonicalGithubRepository(repository: string): string {
  const value = repository.trim();
  if (
    value !== repository
    || !REPOSITORY.test(value)
    || value.endsWith('/.')
    || value.endsWith('/..')
  ) {
    throw new Error(`invalid canonical GitHub repository: ${JSON.stringify(repository)}`);
  }
  return value.toLowerCase();
}

function nonEmptyIdentityField(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length === 0 || trimmed.length > 512) {
    throw new Error(`${name} must be a bounded non-empty identity`);
  }
  return value;
}

function checkedIssueNumber(issueNumber: number): number {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('external GitHub Issue number must be a positive safe integer');
  }
  return issueNumber;
}

function checkedSampleIndex(sampleIndex: number): number {
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error('sample index must be a non-negative safe integer');
  }
  return sampleIndex;
}

export function normalizeExternalWorkIdentity(
  identity: ExternalWorkIdentity,
): ExternalWorkIdentity {
  return {
    repository: canonicalGithubRepository(identity.repository),
    issueNumber: checkedIssueNumber(identity.issueNumber),
    intakeKey: nonEmptyIdentityField('intakeKey', identity.intakeKey),
    workUnitKey: nonEmptyIdentityField('workUnitKey', identity.workUnitKey),
    releaseId: identity.releaseId === null
      ? null
      : nonEmptyIdentityField('releaseId', identity.releaseId),
  };
}

export function projectedWorkIdentity(
  identity: ExternalWorkIdentity,
  sampleIndex: number,
): ProjectedWorkIdentity {
  return {
    ...normalizeExternalWorkIdentity(identity),
    sampleIndex: checkedSampleIndex(sampleIndex),
  };
}

function normalizeProjectedWorkIdentity(
  identity: ProjectedWorkIdentity,
): ProjectedWorkIdentity {
  return projectedWorkIdentity(identity, identity.sampleIndex);
}

function identityJson(identity: ProjectedWorkIdentity): string {
  const normalized = normalizeProjectedWorkIdentity(identity);
  return JSON.stringify({
    repository: normalized.repository,
    issueNumber: normalized.issueNumber,
    intakeKey: normalized.intakeKey,
    workUnitKey: normalized.workUnitKey,
    releaseId: normalized.releaseId,
    sampleIndex: normalized.sampleIndex,
  });
}

function slug(value: string, maximum: number): string {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (normalized || 'work').slice(0, maximum).replace(/-+$/g, '') || 'work';
}

/**
 * Stable physical-resource key. Readable coordinates make incidents legible;
 * the digest is over the complete length-preserving JSON identity, so slug
 * truncation or punctuation normalization cannot alias distinct work.
 */
export function externalSampleKey(
  identity: ExternalWorkIdentity,
  sampleIndex: number,
): string {
  const projected = projectedWorkIdentity(identity, sampleIndex);
  const digest = createHash('sha256').update(identityJson(projected)).digest('hex').slice(0, 16);
  const release = projected.releaseId
    ? `-r${slug(projected.releaseId, 12)}`
    : '';
  return [
    slug(projected.repository.replace('/', '-'), 48),
    `issue-${projected.issueNumber}`,
    slug(projected.workUnitKey, 32),
    `s${projected.sampleIndex}${release}`,
    digest,
  ].join('-');
}

/** Preserve the store-local identity for non-GitHub/local sandbox work only. */
export function sampleKey(
  issueId: string,
  sampleIndex: number,
  externalIdentity?: ExternalWorkIdentity | null,
): string {
  checkedSampleIndex(sampleIndex);
  return externalIdentity
    ? externalSampleKey(externalIdentity, sampleIndex)
    : `${issueId.toLowerCase()}-s${sampleIndex}`;
}

/** Invisible, exact durable correlation placed in every new external PR body. */
export function renderWorkIdentityMarker(identity: ProjectedWorkIdentity): string {
  return `<!-- agentops-work-identity-v1 ${Buffer.from(identityJson(identity)).toString('base64url')} -->`;
}

export function parseWorkIdentityMarker(body: string): ProjectedWorkIdentity | null {
  const matches = [...body.matchAll(IDENTITY_MARKER)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error('pull request body has multiple AgentOps work identity markers');
  }
  try {
    const raw = JSON.parse(Buffer.from(matches[0]![1]!, 'base64url').toString('utf8')) as ProjectedWorkIdentity;
    return normalizeProjectedWorkIdentity(raw);
  } catch (error) {
    throw new Error(
      `pull request body has an invalid AgentOps work identity marker: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function sameProjectedWorkIdentity(
  left: ProjectedWorkIdentity,
  right: ProjectedWorkIdentity,
): boolean {
  return identityJson(left) === identityJson(right);
}

/** Qualified closing/reference target; ambiguous bodies fail closed. */
export function parsePullRequestClosingTarget(
  body: string,
): PullRequestClosingTarget | null {
  const directives = [...body.matchAll(CLOSING_DIRECTIVE)];
  if (directives.length === 0) return null;
  if (directives.length !== 1) {
    throw new Error('pull request body has multiple Issue closing/reference directives');
  }
  const matches = [...body.matchAll(CLOSING_TARGET)];
  if (matches.length !== 1) {
    throw new Error('pull request body Issue target must be one qualified owner/repository#number');
  }
  return {
    relation: matches[0]![1]! as PullRequestClosingTarget['relation'],
    repository: canonicalGithubRepository(matches[0]![2]!),
    issueNumber: checkedIssueNumber(Number(matches[0]![3]!)),
  };
}

export function samePullRequestClosingTarget(
  left: PullRequestClosingTarget | null,
  right: PullRequestClosingTarget | null,
): boolean {
  return left?.relation === right?.relation
    && left?.repository === right?.repository
    && left?.issueNumber === right?.issueNumber;
}
