/**
 * Human-facing, read-only projection of a validated Designflow v1 Design Bundle.
 *
 * Contract/schema and digest validation belong to the Designflow consumer/gate. This module
 * deliberately projects only the published fields needed for a human design decision, while
 * rejecting mixed lineage or missing review evidence that would make the projection misleading.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  digestDesignflowArtifact,
  digestDesignflowManifest,
  type DesignflowBundleInput,
} from './contract-consumer.js';

export type DesignSystemAction = 'reuse' | 'extend' | 'create' | 'feature-local';
export type DesignSystemTargetType = 'token' | 'component' | 'pattern';
export type DesignTaskCriticality = 'primary' | 'secondary' | 'safety';
export type DesignTaskFrequency = 'continuous' | 'frequent' | 'occasional' | 'rare';
export type DesignRegionProminence = 'primary' | 'secondary' | 'supporting' | 'progressive';
export type DesignCapabilityKind = 'query' | 'command' | 'event';

export interface DesignflowExternalReference {
  readonly provider: string;
  readonly externalId: string;
  readonly uri?: string;
  readonly revision?: string;
  readonly digest?: string;
}

export interface DesignflowArtifactReference {
  readonly path: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly schemaRef: string;
}

export interface DesignBundleManifestReviewInput {
  readonly schemaVersion: string;
  readonly bundleId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly sourceDigest: string;
  readonly artifacts: {
    readonly experience: DesignflowArtifactReference;
    readonly designSystemDelta: DesignflowArtifactReference;
    readonly designTokens?: DesignflowArtifactReference;
    readonly capabilityRequirements: DesignflowArtifactReference;
    readonly preview: DesignflowArtifactReference;
  };
  readonly bundleDigest: string;
  readonly createdAt: string;
}

export interface ExperiencePagePurposeReviewInput {
  readonly id: string;
  readonly name: string;
  readonly primaryPurpose: string;
  readonly successOutcome: string;
  readonly secondaryPurposes: readonly string[];
  readonly outOfScope: readonly string[];
  readonly sourceRequirementIds: readonly string[];
}

export interface ExperienceTaskReviewInput {
  readonly id: string;
  readonly pagePurposeId: string;
  readonly goal: string;
  readonly criticality: DesignTaskCriticality;
  readonly frequency?: DesignTaskFrequency;
  readonly sourceRequirementIds: readonly string[];
}

export interface ExperienceEffortBudgetReviewInput {
  readonly id: string;
  readonly taskId: string;
  readonly maxPrimaryActions: number;
  readonly maxDecisions: number;
  readonly maxContextSwitches: number;
  readonly repeatedInputAllowed: boolean;
  readonly rationale: string;
}

export interface ExperienceRegionReviewInput {
  readonly id: string;
  readonly pagePurposeId: string;
  readonly purpose: string;
  readonly order: number;
  readonly groupingRationale: string;
  readonly prominence: DesignRegionProminence;
  readonly responsiveBehavior: string;
  readonly supportsTaskIds: readonly string[];
}

export interface ExperienceElementReviewInput {
  readonly id: string;
  readonly regionId: string;
  readonly kind: string;
  readonly label: string;
  readonly supportsPurposeIds: readonly string[];
  readonly supportsTaskIds: readonly string[];
  readonly informationPriority: number;
  readonly visibleWhen: string;
  readonly placementRationale: string;
  readonly interactionRationale: string;
  readonly removalImpact: string;
  readonly sourceRequirementIds: readonly string[];
}

export interface ExperienceAttentionHierarchyReviewInput {
  readonly pagePurposeId: string;
  readonly levels: readonly {
    readonly level: number;
    readonly reason: string;
    readonly regionIds: readonly string[];
    readonly elementIds: readonly string[];
  }[];
}

export interface ExperienceContractReviewInput {
  readonly requestId: string;
  readonly revisionId: string;
  readonly pagePurposes: readonly ExperiencePagePurposeReviewInput[];
  readonly tasks: readonly ExperienceTaskReviewInput[];
  readonly effortBudgets: readonly ExperienceEffortBudgetReviewInput[];
  readonly regions: readonly ExperienceRegionReviewInput[];
  readonly elements: readonly ExperienceElementReviewInput[];
  readonly attentionHierarchies: readonly ExperienceAttentionHierarchyReviewInput[];
  readonly ambiguities: readonly string[];
}

export interface DesignSystemDeltaReviewInput {
  readonly requestId: string;
  readonly revisionId: string;
  readonly baseRevisionRef: DesignflowExternalReference | null;
  readonly decisions: readonly {
    readonly id: string;
    readonly action: DesignSystemAction;
    readonly targetType: DesignSystemTargetType;
    readonly targetId: string;
    readonly rationale: string;
    readonly sourceRequirementIds: readonly string[];
  }[];
  readonly tokenDocuments: readonly {
    readonly path: string;
    readonly digest: string;
    readonly format: string;
    readonly purpose: string;
  }[];
  readonly componentDeltas: readonly {
    readonly id: string;
    readonly action: DesignSystemAction;
    readonly name: string;
    readonly purpose: string;
    readonly variants: readonly string[];
    readonly states: readonly string[];
    readonly slots: readonly string[];
    readonly keyboardBehavior: string;
    readonly focusBehavior: string;
    readonly responsiveRules: readonly string[];
    readonly contentConstraints: readonly string[];
    readonly tokenRefs: readonly string[];
    readonly sourceRequirementIds: readonly string[];
  }[];
  readonly patternDeltas: readonly {
    readonly id: string;
    readonly action: DesignSystemAction;
    readonly name: string;
    readonly purpose: string;
    readonly compositionRules: readonly string[];
    readonly sourceRequirementIds: readonly string[];
  }[];
}

export interface CapabilityRequirementsReviewInput {
  readonly requestId: string;
  readonly revisionId: string;
  readonly capabilities: readonly {
    readonly id: string;
    readonly kind: DesignCapabilityKind;
    readonly userIntent: string;
    readonly sourceInteractionIds: readonly string[];
    readonly sourceRequirementIds: readonly string[];
    readonly inputDescription: string;
    readonly successOutcome: string;
    readonly failureSemantics: readonly {
      readonly condition: string;
      readonly userVisibleOutcome: string;
      readonly recoverability: string;
    }[];
    readonly authorization: string;
    readonly latencyExpectation: string;
    readonly freshnessExpectation: string;
    readonly concurrencySemantics: string;
    readonly idempotencySemantics: string;
    readonly retrySemantics: string;
    readonly cancellationSemantics: string;
    readonly paginationSemantics: string;
    readonly auditSemantics: string;
  }[];
  readonly ambiguities: readonly string[];
}

export interface DesignBundleReviewInput {
  readonly manifest: DesignBundleManifestReviewInput;
  readonly experience: ExperienceContractReviewInput;
  readonly designSystemDelta: DesignSystemDeltaReviewInput;
  readonly capabilityRequirements: CapabilityRequirementsReviewInput;
  readonly revisionDiff: string;
}

export interface ReviewExternalReference {
  readonly provider: string;
  readonly externalId: string;
  readonly uri: string | null;
  readonly revision: string | null;
  readonly digest: string | null;
}

export interface DesignBundleReviewProjection {
  readonly identity: {
    readonly schemaVersion: string;
    readonly bundleId: string;
    readonly requestId: string;
    readonly revisionId: string;
    readonly previousRevisionId: string | null;
    readonly createdAt: string;
  };
  readonly purposes: readonly {
    readonly id: string;
    readonly name: string;
    readonly purpose: string;
    readonly successOutcome: string;
    readonly secondaryPurposes: readonly string[];
    readonly outOfScope: readonly string[];
    readonly sourceRequirementIds: readonly string[];
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly pagePurpose: {
      readonly id: string;
      readonly name: string;
    };
    readonly goal: string;
    readonly criticality: DesignTaskCriticality;
    readonly frequency: DesignTaskFrequency | null;
    readonly sourceRequirementIds: readonly string[];
  }[];
  readonly effortBudgets: readonly {
    readonly id: string;
    readonly task: {
      readonly id: string;
      readonly goal: string;
    };
    readonly maxPrimaryActions: number;
    readonly maxDecisions: number;
    readonly maxContextSwitches: number;
    readonly repeatedInputAllowed: boolean;
    readonly rationale: string;
  }[];
  readonly attentionHierarchy: readonly {
    readonly pagePurpose: {
      readonly id: string;
      readonly name: string;
    };
    readonly levels: readonly {
      readonly level: number;
      readonly reason: string;
      readonly regions: readonly {
        readonly id: string;
        readonly order: number;
        readonly purpose: string;
        readonly prominence: DesignRegionProminence;
      }[];
      readonly elements: readonly {
        readonly id: string;
        readonly label: string;
        readonly regionId: string;
        readonly informationPriority: number;
      }[];
    }[];
  }[];
  readonly elements: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly region: {
      readonly id: string;
      readonly order: number;
      readonly purpose: string;
      readonly groupingRationale: string;
      readonly prominence: DesignRegionProminence;
      readonly responsiveBehavior: string;
    };
    readonly informationPriority: number;
    readonly visibleWhen: string;
    readonly placementRationale: string;
    readonly interactionRationale: string;
    readonly removalImpact: string;
    readonly supportsPurposeIds: readonly string[];
    readonly supportsTaskIds: readonly string[];
    readonly sourceRequirementIds: readonly string[];
  }[];
  readonly designSystemDelta: {
    readonly baseRevision: ReviewExternalReference | null;
    readonly decisions: readonly {
      readonly id: string;
      readonly action: DesignSystemAction;
      readonly targetType: DesignSystemTargetType;
      readonly targetId: string;
      readonly rationale: string;
      readonly sourceRequirementIds: readonly string[];
    }[];
    readonly tokenDocuments: readonly {
      readonly path: string;
      readonly digest: string;
      readonly format: string;
      readonly purpose: string;
    }[];
    readonly components: readonly {
      readonly id: string;
      readonly action: DesignSystemAction;
      readonly name: string;
      readonly purpose: string;
      readonly variants: readonly string[];
      readonly states: readonly string[];
      readonly slots: readonly string[];
      readonly keyboardBehavior: string;
      readonly focusBehavior: string;
      readonly responsiveRules: readonly string[];
      readonly contentConstraints: readonly string[];
      readonly tokenRefs: readonly string[];
      readonly sourceRequirementIds: readonly string[];
    }[];
    readonly patterns: readonly {
      readonly id: string;
      readonly action: DesignSystemAction;
      readonly name: string;
      readonly purpose: string;
      readonly compositionRules: readonly string[];
      readonly sourceRequirementIds: readonly string[];
    }[];
  };
  readonly capabilityDelta: readonly {
    readonly id: string;
    readonly kind: DesignCapabilityKind;
    readonly userIntent: string;
    readonly sourceInteractionIds: readonly string[];
    readonly sourceRequirementIds: readonly string[];
    readonly inputDescription: string;
    readonly successOutcome: string;
    readonly failureSemantics: readonly {
      readonly condition: string;
      readonly userVisibleOutcome: string;
      readonly recoverability: string;
    }[];
    readonly authorization: string;
    readonly latencyExpectation: string;
    readonly freshnessExpectation: string;
    readonly concurrencySemantics: string;
    readonly idempotencySemantics: string;
    readonly retrySemantics: string;
    readonly cancellationSemantics: string;
    readonly paginationSemantics: string;
    readonly auditSemantics: string;
  }[];
  readonly revisionDiff: string;
  readonly ambiguities: readonly {
    readonly source: 'experience' | 'capability';
    readonly text: string;
  }[];
  readonly digest: {
    readonly sourceDigest: string;
    readonly bundleDigest: string;
    readonly artifacts: readonly {
      readonly kind:
        | 'experience'
        | 'design-system-delta'
        | 'design-tokens'
        | 'capability-requirements'
        | 'preview';
      readonly path: string;
      readonly digest: string;
      readonly mediaType: string;
      readonly schemaRef: string;
    }[];
  };
}

export class DesignBundleReviewProjectionError extends Error {
  constructor(message: string) {
    super(`Cannot project Design Bundle review: ${message}`);
    this.name = 'DesignBundleReviewProjectionError';
  }
}

function containedMaterializedFile(
  bundleRoot: string,
  candidate: string,
  label: string,
): string {
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(path.resolve(bundleRoot));
    const resolved = path.resolve(root, candidate);
    const relative = path.relative(root, resolved);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new Error('path escapes bundleRoot');
    }
    file = fs.realpathSync(resolved);
    const realRelative = path.relative(root, file);
    if (
      realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)
    ) {
      throw new Error('path resolves outside bundleRoot');
    }
    if (!fs.statSync(file).isFile()) throw new Error('path is not a file');
  } catch (error) {
    throw new DesignBundleReviewProjectionError(
      `${label} cannot be materialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return file;
}

function readMaterializedJson(
  bundleRoot: string,
  candidate: string,
  label: string,
): { value: Record<string, unknown>; bytes: Buffer } {
  const file = containedMaterializedFile(bundleRoot, candidate, label);
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = fs.readFileSync(file);
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new DesignBundleReviewProjectionError(
      `${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesignBundleReviewProjectionError(`${label} must be a JSON object`);
  }
  return { value: value as Record<string, unknown>, bytes };
}

function materializedArtifactReference(
  manifest: Record<string, unknown>,
  artifactId: 'experience' | 'designSystemDelta' | 'capabilityRequirements',
): DesignflowArtifactReference {
  const artifacts = manifest.artifacts;
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new DesignBundleReviewProjectionError('manifest.artifacts must be an object');
  }
  const reference = (artifacts as Record<string, unknown>)[artifactId];
  if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new DesignBundleReviewProjectionError(
      `manifest.artifacts.${artifactId} is required`,
    );
  }
  const candidate = reference as Record<string, unknown>;
  return {
    path: requiredText(candidate.path, `manifest.artifacts.${artifactId}.path`),
    digest: requiredText(candidate.digest, `manifest.artifacts.${artifactId}.digest`),
    mediaType: requiredText(
      candidate.mediaType,
      `manifest.artifacts.${artifactId}.mediaType`,
    ),
    schemaRef: requiredText(
      candidate.schemaRef,
      `manifest.artifacts.${artifactId}.schemaRef`,
    ),
  };
}

function readDigestBoundReviewArtifact<T>(
  bundleRoot: string,
  reference: DesignflowArtifactReference,
  label: string,
): T {
  const loaded = readMaterializedJson(bundleRoot, reference.path, label);
  const digest = digestDesignflowArtifact(loaded.bytes, reference.mediaType);
  if (digest !== reference.digest) {
    throw new DesignBundleReviewProjectionError(
      `${label} digest ${digest} does not match manifest reference ${reference.digest}`,
    );
  }
  return loaded.value as T;
}

/**
 * Re-read the exact manifest-addressed artifacts after the contract consumer has validated the
 * bundle. Manifest and artifact digests are checked again, so provider-supplied parallel decoded
 * prose cannot diverge from the bytes that passed the gate.
 *
 * revision-diff.md is intentionally not read: v1 does not authenticate it in the manifest.
 * The projection carries a workflow-authored lineage note instead of trusting supplemental prose.
 */
export function projectMaterializedDesignBundleReview(
  input: DesignflowBundleInput,
): DesignBundleReviewProjection {
  const loadedManifest = readMaterializedJson(
    input.bundleRoot,
    input.manifestPath,
    'Design Bundle Manifest',
  );
  const manifest = loadedManifest.value;
  const declaredBundleDigest = requiredText(
    manifest.bundleDigest,
    'manifest.bundleDigest',
  );
  const actualBundleDigest = digestDesignflowManifest(
    manifest as Parameters<typeof digestDesignflowManifest>[0],
  );
  if (actualBundleDigest !== declaredBundleDigest) {
    throw new DesignBundleReviewProjectionError(
      `manifest bundleDigest ${declaredBundleDigest} does not match ${actualBundleDigest}`,
    );
  }

  const experienceRef = materializedArtifactReference(manifest, 'experience');
  const designSystemRef = materializedArtifactReference(manifest, 'designSystemDelta');
  const capabilityRef = materializedArtifactReference(
    manifest,
    'capabilityRequirements',
  );
  const currentRevision = requiredText(manifest.revisionId, 'manifest.revisionId');
  const previousRevision = manifest.previousRevisionId;
  const lineageNote = previousRevision === null
    ? `Workflow-authenticated lineage: ${currentRevision} is the initial bundle revision. `
      + 'The v1 manifest does not authenticate a prose revision diff.'
    : `Workflow-authenticated lineage: ${currentRevision} follows `
      + `${requiredText(previousRevision, 'manifest.previousRevisionId')}. `
      + 'The v1 manifest does not authenticate a prose revision diff.';

  return projectDesignBundleReview({
    manifest: manifest as unknown as DesignBundleManifestReviewInput,
    experience: readDigestBoundReviewArtifact<ExperienceContractReviewInput>(
      input.bundleRoot,
      experienceRef,
      'Experience Contract',
    ),
    designSystemDelta: readDigestBoundReviewArtifact<DesignSystemDeltaReviewInput>(
      input.bundleRoot,
      designSystemRef,
      'Design System Delta',
    ),
    capabilityRequirements:
      readDigestBoundReviewArtifact<CapabilityRequirementsReviewInput>(
        input.bundleRoot,
        capabilityRef,
        'Capability Requirements',
      ),
    revisionDiff: lineageNote,
  });
}

const CRITICALITY_RANK: Readonly<Record<DesignTaskCriticality, number>> = {
  primary: 0,
  secondary: 1,
  safety: 2,
};
const ACTION_RANK: Readonly<Record<DesignSystemAction, number>> = {
  reuse: 0,
  extend: 1,
  create: 2,
  'feature-local': 3,
};
const TARGET_TYPE_RANK: Readonly<Record<DesignSystemTargetType, number>> = {
  token: 0,
  component: 1,
  pattern: 2,
};
const CAPABILITY_KIND_RANK: Readonly<Record<DesignCapabilityKind, number>> = {
  query: 0,
  command: 1,
  event: 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DesignBundleReviewProjectionError(`${field} is required`);
  }
  return value;
}

function copyTextList(values: readonly string[], field: string): string[] {
  return values.map((value, index) => requiredText(value, `${field}[${index}]`));
}

function copySortedIds(values: readonly string[], field: string): string[] {
  return copyTextList(values, field).sort(compareText);
}

function indexUnique<T>(
  items: readonly T[],
  id: (item: T) => string,
  field: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const item of items) {
    const key = requiredText(id(item), `${field}.id`);
    if (indexed.has(key)) {
      throw new DesignBundleReviewProjectionError(`${field} contains duplicate id ${key}`);
    }
    indexed.set(key, item);
  }
  return indexed;
}

function requireReference<T>(indexed: ReadonlyMap<string, T>, id: string, field: string): T {
  const value = indexed.get(id);
  if (!value) {
    throw new DesignBundleReviewProjectionError(`${field} references missing id ${id}`);
  }
  return value;
}

function stableRank(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

function rankOf(ranks: ReadonlyMap<string, number>, id: string): number {
  return ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
}

function copyExternalReference(reference: DesignflowExternalReference): ReviewExternalReference {
  return {
    provider: requiredText(reference.provider, 'designSystemDelta.baseRevisionRef.provider'),
    externalId: requiredText(reference.externalId, 'designSystemDelta.baseRevisionRef.externalId'),
    uri: reference.uri ?? null,
    revision: reference.revision ?? null,
    digest: reference.digest ?? null,
  };
}

function copyArtifact(
  kind: DesignBundleReviewProjection['digest']['artifacts'][number]['kind'],
  artifact: DesignflowArtifactReference,
): DesignBundleReviewProjection['digest']['artifacts'][number] {
  return {
    kind,
    path: requiredText(artifact.path, `manifest.artifacts.${kind}.path`),
    digest: requiredText(artifact.digest, `manifest.artifacts.${kind}.digest`),
    mediaType: requiredText(artifact.mediaType, `manifest.artifacts.${kind}.mediaType`),
    schemaRef: requiredText(artifact.schemaRef, `manifest.artifacts.${kind}.schemaRef`),
  };
}

function assertLineage(input: DesignBundleReviewInput): void {
  const expectedRequest = requiredText(input.manifest.requestId, 'manifest.requestId');
  const expectedRevision = requiredText(input.manifest.revisionId, 'manifest.revisionId');
  const artifacts = [
    ['experience', input.experience],
    ['designSystemDelta', input.designSystemDelta],
    ['capabilityRequirements', input.capabilityRequirements],
  ] as const;

  for (const [name, artifact] of artifacts) {
    if (artifact.requestId !== expectedRequest) {
      throw new DesignBundleReviewProjectionError(
        `${name}.requestId ${artifact.requestId} does not match manifest.requestId ${expectedRequest}`,
      );
    }
    if (artifact.revisionId !== expectedRevision) {
      throw new DesignBundleReviewProjectionError(
        `${name}.revisionId ${artifact.revisionId} does not match manifest.revisionId ${expectedRevision}`,
      );
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the deterministic projection used by any human review surface.
 *
 * Ordering is semantic and input-order independent: purpose/task/region/element relationships
 * come first, followed by explicit Design System action and Capability kind order. Set-like ID
 * lists are lexical. Authored prose/rule lists retain their contract order.
 */
export function projectDesignBundleReview(
  input: DesignBundleReviewInput,
): DesignBundleReviewProjection {
  assertLineage(input);

  const purposeById = indexUnique(input.experience.pagePurposes, (purpose) => purpose.id, 'pagePurposes');
  const purposes = [...input.experience.pagePurposes].sort((left, right) => compareText(left.id, right.id));
  const purposeRank = stableRank(purposes.map((purpose) => purpose.id));

  const taskById = indexUnique(input.experience.tasks, (task) => task.id, 'tasks');
  const tasks = [...input.experience.tasks].sort((left, right) =>
    compareNumber(rankOf(purposeRank, left.pagePurposeId), rankOf(purposeRank, right.pagePurposeId))
    || compareNumber(CRITICALITY_RANK[left.criticality], CRITICALITY_RANK[right.criticality])
    || compareText(left.id, right.id));
  const taskRank = stableRank(tasks.map((task) => task.id));

  const regionById = indexUnique(input.experience.regions, (region) => region.id, 'regions');
  const regions = [...input.experience.regions].sort((left, right) =>
    compareNumber(rankOf(purposeRank, left.pagePurposeId), rankOf(purposeRank, right.pagePurposeId))
    || compareNumber(left.order, right.order)
    || compareText(left.id, right.id));
  const regionRank = stableRank(regions.map((region) => region.id));

  const elementById = indexUnique(input.experience.elements, (element) => element.id, 'elements');
  const elements = [...input.experience.elements].sort((left, right) =>
    compareNumber(rankOf(regionRank, left.regionId), rankOf(regionRank, right.regionId))
    || compareNumber(left.informationPriority, right.informationPriority)
    || compareText(left.id, right.id));
  const elementRank = stableRank(elements.map((element) => element.id));

  const projection: DesignBundleReviewProjection = {
    identity: {
      schemaVersion: requiredText(input.manifest.schemaVersion, 'manifest.schemaVersion'),
      bundleId: requiredText(input.manifest.bundleId, 'manifest.bundleId'),
      requestId: input.manifest.requestId,
      revisionId: input.manifest.revisionId,
      previousRevisionId: input.manifest.previousRevisionId,
      createdAt: requiredText(input.manifest.createdAt, 'manifest.createdAt'),
    },
    purposes: purposes.map((purpose) => ({
      id: requiredText(purpose.id, 'pagePurposes.id'),
      name: requiredText(purpose.name, `pagePurposes.${purpose.id}.name`),
      purpose: requiredText(purpose.primaryPurpose, `pagePurposes.${purpose.id}.primaryPurpose`),
      successOutcome: requiredText(purpose.successOutcome, `pagePurposes.${purpose.id}.successOutcome`),
      secondaryPurposes: copyTextList(
        purpose.secondaryPurposes,
        `pagePurposes.${purpose.id}.secondaryPurposes`,
      ),
      outOfScope: copyTextList(purpose.outOfScope, `pagePurposes.${purpose.id}.outOfScope`),
      sourceRequirementIds: copySortedIds(
        purpose.sourceRequirementIds,
        `pagePurposes.${purpose.id}.sourceRequirementIds`,
      ),
    })),
    tasks: tasks.map((task) => {
      const purpose = requireReference(purposeById, task.pagePurposeId, `tasks.${task.id}.pagePurposeId`);
      return {
        id: requiredText(task.id, 'tasks.id'),
        pagePurpose: {
          id: purpose.id,
          name: requiredText(purpose.name, `pagePurposes.${purpose.id}.name`),
        },
        goal: requiredText(task.goal, `tasks.${task.id}.goal`),
        criticality: task.criticality,
        frequency: task.frequency ?? null,
        sourceRequirementIds: copySortedIds(
          task.sourceRequirementIds,
          `tasks.${task.id}.sourceRequirementIds`,
        ),
      };
    }),
    effortBudgets: [...input.experience.effortBudgets]
      .sort((left, right) =>
        compareNumber(rankOf(taskRank, left.taskId), rankOf(taskRank, right.taskId))
        || compareText(left.id, right.id))
      .map((budget) => {
        const task = requireReference(taskById, budget.taskId, `effortBudgets.${budget.id}.taskId`);
        return {
          id: requiredText(budget.id, 'effortBudgets.id'),
          task: {
            id: task.id,
            goal: requiredText(task.goal, `tasks.${task.id}.goal`),
          },
          maxPrimaryActions: budget.maxPrimaryActions,
          maxDecisions: budget.maxDecisions,
          maxContextSwitches: budget.maxContextSwitches,
          repeatedInputAllowed: budget.repeatedInputAllowed,
          rationale: requiredText(budget.rationale, `effortBudgets.${budget.id}.rationale`),
        };
      }),
    attentionHierarchy: [...input.experience.attentionHierarchies]
      .sort((left, right) =>
        compareNumber(
          rankOf(purposeRank, left.pagePurposeId),
          rankOf(purposeRank, right.pagePurposeId),
        )
        || compareText(left.pagePurposeId, right.pagePurposeId))
      .map((hierarchy) => {
        const purpose = requireReference(
          purposeById,
          hierarchy.pagePurposeId,
          'attentionHierarchies.pagePurposeId',
        );
        return {
          pagePurpose: {
            id: purpose.id,
            name: requiredText(purpose.name, `pagePurposes.${purpose.id}.name`),
          },
          levels: [...hierarchy.levels]
            .sort((left, right) => compareNumber(left.level, right.level))
            .map((level) => ({
              level: level.level,
              reason: requiredText(
                level.reason,
                `attentionHierarchies.${hierarchy.pagePurposeId}.level.${level.level}.reason`,
              ),
              regions: level.regionIds
                .map((id) => requireReference(
                  regionById,
                  id,
                  `attentionHierarchies.${hierarchy.pagePurposeId}.level.${level.level}.regionIds`,
                ))
                .sort((left, right) =>
                  compareNumber(rankOf(regionRank, left.id), rankOf(regionRank, right.id)))
                .map((region) => ({
                  id: region.id,
                  order: region.order,
                  purpose: requiredText(region.purpose, `regions.${region.id}.purpose`),
                  prominence: region.prominence,
                })),
              elements: level.elementIds
                .map((id) => requireReference(
                  elementById,
                  id,
                  `attentionHierarchies.${hierarchy.pagePurposeId}.level.${level.level}.elementIds`,
                ))
                .sort((left, right) =>
                  compareNumber(rankOf(elementRank, left.id), rankOf(elementRank, right.id)))
                .map((element) => ({
                  id: element.id,
                  label: requiredText(element.label, `elements.${element.id}.label`),
                  regionId: element.regionId,
                  informationPriority: element.informationPriority,
                })),
            })),
        };
      }),
    elements: elements.map((element) => {
      const region = requireReference(regionById, element.regionId, `elements.${element.id}.regionId`);
      return {
        id: requiredText(element.id, 'elements.id'),
        label: requiredText(element.label, `elements.${element.id}.label`),
        kind: requiredText(element.kind, `elements.${element.id}.kind`),
        region: {
          id: region.id,
          order: region.order,
          purpose: requiredText(region.purpose, `regions.${region.id}.purpose`),
          groupingRationale: requiredText(
            region.groupingRationale,
            `regions.${region.id}.groupingRationale`,
          ),
          prominence: region.prominence,
          responsiveBehavior: requiredText(
            region.responsiveBehavior,
            `regions.${region.id}.responsiveBehavior`,
          ),
        },
        informationPriority: element.informationPriority,
        visibleWhen: requiredText(element.visibleWhen, `elements.${element.id}.visibleWhen`),
        placementRationale: requiredText(
          element.placementRationale,
          `elements.${element.id}.placementRationale`,
        ),
        interactionRationale: requiredText(
          element.interactionRationale,
          `elements.${element.id}.interactionRationale`,
        ),
        removalImpact: requiredText(element.removalImpact, `elements.${element.id}.removalImpact`),
        supportsPurposeIds: copySortedIds(
          element.supportsPurposeIds,
          `elements.${element.id}.supportsPurposeIds`,
        ),
        supportsTaskIds: copySortedIds(
          element.supportsTaskIds,
          `elements.${element.id}.supportsTaskIds`,
        ),
        sourceRequirementIds: copySortedIds(
          element.sourceRequirementIds,
          `elements.${element.id}.sourceRequirementIds`,
        ),
      };
    }),
    designSystemDelta: {
      baseRevision: input.designSystemDelta.baseRevisionRef
        ? copyExternalReference(input.designSystemDelta.baseRevisionRef)
        : null,
      decisions: [...input.designSystemDelta.decisions]
        .sort((left, right) =>
          compareNumber(ACTION_RANK[left.action], ACTION_RANK[right.action])
          || compareNumber(TARGET_TYPE_RANK[left.targetType], TARGET_TYPE_RANK[right.targetType])
          || compareText(left.targetId, right.targetId)
          || compareText(left.id, right.id))
        .map((decision) => ({
          id: requiredText(decision.id, 'designSystemDelta.decisions.id'),
          action: decision.action,
          targetType: decision.targetType,
          targetId: requiredText(
            decision.targetId,
            `designSystemDelta.decisions.${decision.id}.targetId`,
          ),
          rationale: requiredText(
            decision.rationale,
            `designSystemDelta.decisions.${decision.id}.rationale`,
          ),
          sourceRequirementIds: copySortedIds(
            decision.sourceRequirementIds,
            `designSystemDelta.decisions.${decision.id}.sourceRequirementIds`,
          ),
        })),
      tokenDocuments: [...input.designSystemDelta.tokenDocuments]
        .sort((left, right) => compareText(left.path, right.path))
        .map((document) => ({
          path: requiredText(document.path, 'designSystemDelta.tokenDocuments.path'),
          digest: requiredText(
            document.digest,
            `designSystemDelta.tokenDocuments.${document.path}.digest`,
          ),
          format: requiredText(
            document.format,
            `designSystemDelta.tokenDocuments.${document.path}.format`,
          ),
          purpose: requiredText(
            document.purpose,
            `designSystemDelta.tokenDocuments.${document.path}.purpose`,
          ),
        })),
      components: [...input.designSystemDelta.componentDeltas]
        .sort((left, right) =>
          compareNumber(ACTION_RANK[left.action], ACTION_RANK[right.action])
          || compareText(left.id, right.id))
        .map((component) => ({
          id: requiredText(component.id, 'designSystemDelta.componentDeltas.id'),
          action: component.action,
          name: requiredText(
            component.name,
            `designSystemDelta.componentDeltas.${component.id}.name`,
          ),
          purpose: requiredText(
            component.purpose,
            `designSystemDelta.componentDeltas.${component.id}.purpose`,
          ),
          variants: copyTextList(
            component.variants,
            `designSystemDelta.componentDeltas.${component.id}.variants`,
          ),
          states: copyTextList(
            component.states,
            `designSystemDelta.componentDeltas.${component.id}.states`,
          ),
          slots: copyTextList(
            component.slots,
            `designSystemDelta.componentDeltas.${component.id}.slots`,
          ),
          keyboardBehavior: requiredText(
            component.keyboardBehavior,
            `designSystemDelta.componentDeltas.${component.id}.keyboardBehavior`,
          ),
          focusBehavior: requiredText(
            component.focusBehavior,
            `designSystemDelta.componentDeltas.${component.id}.focusBehavior`,
          ),
          responsiveRules: copyTextList(
            component.responsiveRules,
            `designSystemDelta.componentDeltas.${component.id}.responsiveRules`,
          ),
          contentConstraints: copyTextList(
            component.contentConstraints,
            `designSystemDelta.componentDeltas.${component.id}.contentConstraints`,
          ),
          tokenRefs: copySortedIds(
            component.tokenRefs,
            `designSystemDelta.componentDeltas.${component.id}.tokenRefs`,
          ),
          sourceRequirementIds: copySortedIds(
            component.sourceRequirementIds,
            `designSystemDelta.componentDeltas.${component.id}.sourceRequirementIds`,
          ),
        })),
      patterns: [...input.designSystemDelta.patternDeltas]
        .sort((left, right) =>
          compareNumber(ACTION_RANK[left.action], ACTION_RANK[right.action])
          || compareText(left.id, right.id))
        .map((pattern) => ({
          id: requiredText(pattern.id, 'designSystemDelta.patternDeltas.id'),
          action: pattern.action,
          name: requiredText(
            pattern.name,
            `designSystemDelta.patternDeltas.${pattern.id}.name`,
          ),
          purpose: requiredText(
            pattern.purpose,
            `designSystemDelta.patternDeltas.${pattern.id}.purpose`,
          ),
          compositionRules: copyTextList(
            pattern.compositionRules,
            `designSystemDelta.patternDeltas.${pattern.id}.compositionRules`,
          ),
          sourceRequirementIds: copySortedIds(
            pattern.sourceRequirementIds,
            `designSystemDelta.patternDeltas.${pattern.id}.sourceRequirementIds`,
          ),
        })),
    },
    capabilityDelta: [...input.capabilityRequirements.capabilities]
      .sort((left, right) =>
        compareNumber(CAPABILITY_KIND_RANK[left.kind], CAPABILITY_KIND_RANK[right.kind])
        || compareText(left.id, right.id))
      .map((capability) => ({
        id: requiredText(capability.id, 'capabilityRequirements.capabilities.id'),
        kind: capability.kind,
        userIntent: requiredText(
          capability.userIntent,
          `capabilityRequirements.capabilities.${capability.id}.userIntent`,
        ),
        sourceInteractionIds: copySortedIds(
          capability.sourceInteractionIds,
          `capabilityRequirements.capabilities.${capability.id}.sourceInteractionIds`,
        ),
        sourceRequirementIds: copySortedIds(
          capability.sourceRequirementIds,
          `capabilityRequirements.capabilities.${capability.id}.sourceRequirementIds`,
        ),
        inputDescription: requiredText(
          capability.inputDescription,
          `capabilityRequirements.capabilities.${capability.id}.inputDescription`,
        ),
        successOutcome: requiredText(
          capability.successOutcome,
          `capabilityRequirements.capabilities.${capability.id}.successOutcome`,
        ),
        failureSemantics: [...capability.failureSemantics]
          .sort((left, right) => compareText(left.condition, right.condition))
          .map((failure, index) => ({
            condition: requiredText(
              failure.condition,
              `capabilityRequirements.capabilities.${capability.id}.failureSemantics.${index}.condition`,
            ),
            userVisibleOutcome: requiredText(
              failure.userVisibleOutcome,
              `capabilityRequirements.capabilities.${capability.id}.failureSemantics.${index}.userVisibleOutcome`,
            ),
            recoverability: requiredText(
              failure.recoverability,
              `capabilityRequirements.capabilities.${capability.id}.failureSemantics.${index}.recoverability`,
            ),
          })),
        authorization: requiredText(
          capability.authorization,
          `capabilityRequirements.capabilities.${capability.id}.authorization`,
        ),
        latencyExpectation: requiredText(
          capability.latencyExpectation,
          `capabilityRequirements.capabilities.${capability.id}.latencyExpectation`,
        ),
        freshnessExpectation: requiredText(
          capability.freshnessExpectation,
          `capabilityRequirements.capabilities.${capability.id}.freshnessExpectation`,
        ),
        concurrencySemantics: requiredText(
          capability.concurrencySemantics,
          `capabilityRequirements.capabilities.${capability.id}.concurrencySemantics`,
        ),
        idempotencySemantics: requiredText(
          capability.idempotencySemantics,
          `capabilityRequirements.capabilities.${capability.id}.idempotencySemantics`,
        ),
        retrySemantics: requiredText(
          capability.retrySemantics,
          `capabilityRequirements.capabilities.${capability.id}.retrySemantics`,
        ),
        cancellationSemantics: requiredText(
          capability.cancellationSemantics,
          `capabilityRequirements.capabilities.${capability.id}.cancellationSemantics`,
        ),
        paginationSemantics: requiredText(
          capability.paginationSemantics,
          `capabilityRequirements.capabilities.${capability.id}.paginationSemantics`,
        ),
        auditSemantics: requiredText(
          capability.auditSemantics,
          `capabilityRequirements.capabilities.${capability.id}.auditSemantics`,
        ),
      })),
    revisionDiff: requiredText(input.revisionDiff, 'revisionDiff')
      .replace(/\r\n?/g, '\n')
      .trim(),
    ambiguities: [
      ...input.experience.ambiguities.map((text) => ({
        source: 'experience' as const,
        text: requiredText(text, 'experience.ambiguities'),
      })),
      ...input.capabilityRequirements.ambiguities.map((text) => ({
        source: 'capability' as const,
        text: requiredText(text, 'capabilityRequirements.ambiguities'),
      })),
    ].sort((left, right) =>
      compareText(left.source, right.source) || compareText(left.text, right.text)),
    digest: {
      sourceDigest: requiredText(input.manifest.sourceDigest, 'manifest.sourceDigest'),
      bundleDigest: requiredText(input.manifest.bundleDigest, 'manifest.bundleDigest'),
      artifacts: [
        copyArtifact('experience', input.manifest.artifacts.experience),
        copyArtifact('design-system-delta', input.manifest.artifacts.designSystemDelta),
        ...(input.manifest.artifacts.designTokens
          ? [copyArtifact('design-tokens', input.manifest.artifacts.designTokens)]
          : []),
        copyArtifact(
          'capability-requirements',
          input.manifest.artifacts.capabilityRequirements,
        ),
        copyArtifact('preview', input.manifest.artifacts.preview),
      ],
    },
  };

  return deepFreeze(projection);
}
