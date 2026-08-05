import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type { AnySchema, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

export const DESIGNFLOW_CONTRACT_PIN = Object.freeze({
  providerRef: 'mrbaron3/designflow@contract-v1.0.0-rc.1',
  tag: 'contract-v1.0.0-rc.1',
  tagObject: 'a5598951bbc405f9d83ebbccc184c7994844715b',
  commit: 'ce732a80a8c3867b4ac881531ce8f7546e001dbb',
  contractPath: 'contracts/v1',
  sourceTree: 'git-sha1:2cc524f43dbea6f99f830c80768baee083a7edcc',
  contractDigest: 'sha256:72be2a2eb13ae7dbb02c89ee2f3a9b9d581b7a0c2210a4ad6aab1b9d89fb2c83',
});

export const DEFAULT_DESIGNFLOW_LOCK_PATH =
  'contracts/designflow/contract-v1.0.0-rc.1/contract.lock.json';

const LOCK_DIGEST_ALGORITHM = 'sha256-rfc8785-lock-input-v1';
const JSON_MEDIA_TYPE = 'application/json';
const DESIGN_TOKENS_SCHEMA_REF =
  'https://www.designtokens.org/TR/2025.10/format/';
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const SCHEMA_REFS = Object.freeze({
  designRequest: 'urn:designflow:schema:v1:design-request',
  experience: 'urn:designflow:schema:v1:experience-contract',
  designSystemDelta: 'urn:designflow:schema:v1:design-system-delta',
  capabilityRequirements: 'urn:designflow:schema:v1:capability-requirements',
  manifest: 'urn:designflow:schema:v1:design-bundle-manifest',
  humanDecision: 'urn:designflow:schema:v1:human-design-decision',
});

const ARTIFACT_SCHEMA_REFS = new Set<string>([
  SCHEMA_REFS.experience,
  SCHEMA_REFS.designSystemDelta,
  SCHEMA_REFS.capabilityRequirements,
]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface LockedFile {
  localPath: string;
  digest: string;
}

export interface DesignflowContractLock {
  schemaVersion: '1.0';
  providerRef: string;
  tag: string;
  tagObject: string;
  commit: string;
  contractPath: string;
  sourceTree: string;
  digestAlgorithm: string;
  contractDigest: string;
  provenance: {
    contract: LockedFile;
    schemas: LockedFile;
  };
  files: Record<string, LockedFile>;
}

export interface DesignflowContractConsumerOptions {
  /** Root of the workflow checkout containing the pinned lock and schemas. */
  repositoryRoot: string;
  /** Repository-relative or absolute lock path; defaults to the reviewed RC.1 pin. */
  lockPath?: string;
}

export interface DesignflowBundleInput {
  /** Root against which all provider-authored paths are resolved. */
  bundleRoot: string;
  /** Path to the Design Bundle Manifest, relative to bundleRoot unless absolute. */
  manifestPath: string;
  /** Path to the source Design Request, relative to bundleRoot unless absolute. */
  designRequestPath: string;
  /** Optional Human Design Decision for the same revision. */
  humanDecisionPath?: string;
}

export interface DesignflowContractResult {
  providerRef: string;
  providerCommit: string;
  contractDigest: string;
  bundleId: string;
  requestId: string;
  revisionId: string;
  sourceDigest: string;
  bundleDigest: string;
  artifactIds: string[];
  capabilityIds: string[];
  decisionId?: string;
  decisionVerdict?: string;
  decisionSupersedesDecisionId?: string | null;
}

interface DesignRequest extends JsonObject {
  requestId: string;
  requirements: Array<{ id: string }>;
}

interface ExperienceContract extends JsonObject {
  requestId: string;
  revisionId: string;
  pagePurposes: Array<{ id: string; sourceRequirementIds: string[] }>;
  tasks: Array<{
    id: string;
    pagePurposeId: string;
    sourceRequirementIds: string[];
  }>;
  flows: Array<{
    id: string;
    taskId: string;
    steps: Array<{ id: string; capabilityRequirementIds: string[] }>;
  }>;
  effortBudgets: Array<{ id: string; taskId: string }>;
  regions: Array<{
    id: string;
    pagePurposeId: string;
    supportsTaskIds: string[];
  }>;
  elements: Array<{
    id: string;
    regionId: string;
    supportsPurposeIds: string[];
    supportsTaskIds: string[];
    sourceRequirementIds: string[];
  }>;
  attentionHierarchies: Array<{
    pagePurposeId: string;
    levels: Array<{
      level: number;
      regionIds: string[];
      elementIds: string[];
    }>;
  }>;
  ambiguities: string[];
}

interface DesignSystemDelta extends JsonObject {
  requestId: string;
  revisionId: string;
  decisions: Array<{ id: string; sourceRequirementIds: string[] }>;
  tokenDocuments: Array<{ path: string; digest: string }>;
  componentDeltas: Array<{ id: string; sourceRequirementIds: string[] }>;
  patternDeltas: Array<{ id: string; sourceRequirementIds: string[] }>;
}

interface CapabilityRequirements extends JsonObject {
  requestId: string;
  revisionId: string;
  capabilities: Array<{
    id: string;
    sourceInteractionIds: string[];
    sourceRequirementIds: string[];
  }>;
}

interface ArtifactReference extends JsonObject {
  path: string;
  digest: string;
  mediaType: string;
  schemaRef: string;
}

interface DesignBundleManifest extends JsonObject {
  bundleId: string;
  requestId: string;
  revisionId: string;
  sourceDigest: string;
  artifacts: Record<string, ArtifactReference>;
  bundleDigest: string;
}

interface HumanDesignDecision extends JsonObject {
  decisionId: string;
  requestId: string;
  revisionId: string;
  bundleDigest: string;
  verdict: string;
  supersedesDecisionId: string | null;
}

interface LoadedJson {
  bytes: Buffer;
  value: JsonObject;
  filePath: string;
}

export class DesignflowContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignflowContractError';
  }
}

/**
 * Generic consumer for the reviewed Designflow RC.1 published contract.
 *
 * It owns no provider runtime or Dashboard-specific trust anchors. The constructor
 * verifies the local lock/provenance and builds Ajv validators from the exact schema
 * files already embedded by the Go gate; validateBundle then accepts any materialized
 * candidate rooted at bundleRoot.
 */
export class DesignflowContractConsumer {
  readonly lock: DesignflowContractLock;

  private readonly repositoryRoot: string;
  private readonly validators: Map<string, ValidateFunction>;

  constructor(options: DesignflowContractConsumerOptions) {
    this.repositoryRoot = realDirectory(options.repositoryRoot, 'repository root');
    const lockPath = resolveContainedFile(
      this.repositoryRoot,
      options.lockPath ?? DEFAULT_DESIGNFLOW_LOCK_PATH,
      'Designflow contract lock',
    );
    this.lock = loadAndVerifyLock(this.repositoryRoot, lockPath);
    this.validators = loadValidators(this.repositoryRoot, this.lock);
  }

  validateBundle(input: DesignflowBundleInput): DesignflowContractResult {
    const bundleRoot = realDirectory(input.bundleRoot, 'Designflow bundle root');
    const manifest = readBundleJson(
      bundleRoot,
      input.manifestPath,
      'Design Bundle Manifest',
    );
    this.validateSchema(SCHEMA_REFS.manifest, manifest.value, manifest.filePath);
    const bundle = manifest.value as DesignBundleManifest;

    const designRequest = readBundleJson(
      bundleRoot,
      input.designRequestPath,
      'Design Request',
    );
    this.validateSchema(
      SCHEMA_REFS.designRequest,
      designRequest.value,
      designRequest.filePath,
    );
    const request = designRequest.value as DesignRequest;
    const sourceDigest = digestDesignflowArtifact(designRequest.bytes, JSON_MEDIA_TYPE);
    assert(
      sourceDigest === bundle.sourceDigest,
      `Design Bundle Manifest sourceDigest mismatch: expected ${bundle.sourceDigest}, got ${sourceDigest}`,
    );

    const artifacts = new Map<string, JsonObject>();
    for (const [artifactId, reference] of Object.entries(bundle.artifacts)) {
      const artifactPath = resolveContainedFile(
        bundleRoot,
        reference.path,
        `bundle artifact ${artifactId}`,
      );
      const bytes = readFile(artifactPath, `bundle artifact ${artifactId}`);
      const actualDigest = digestDesignflowArtifact(bytes, reference.mediaType);
      assert(
        actualDigest === reference.digest,
        `bundle artifact ${artifactId} digest mismatch: expected ${reference.digest}, got ${actualDigest}`,
      );

      if (ARTIFACT_SCHEMA_REFS.has(reference.schemaRef)) {
        const type = mediaType(reference.mediaType);
        assert(
          type === JSON_MEDIA_TYPE || type.endsWith('+json'),
          `bundle artifact ${artifactId} uses JSON schema ${reference.schemaRef} with non-JSON media type ${reference.mediaType}`,
        );
        const value = parseJsonObject(bytes, `bundle artifact ${artifactId}`);
        this.validateSchema(reference.schemaRef, value, artifactPath);
        artifacts.set(artifactId, value);
      } else if (reference.schemaRef === DESIGN_TOKENS_SCHEMA_REF) {
        assert(
          mediaType(reference.mediaType).endsWith('+json'),
          `design token artifact ${artifactId} has non-JSON media type ${reference.mediaType}`,
        );
        const value = parseJsonObject(bytes, `design token artifact ${artifactId}`);
        validateDesignTokens(value);
        artifacts.set(artifactId, value);
      } else if (reference.schemaRef === 'none') {
        assert(
          mediaType(reference.mediaType) === 'text/html',
          `bundle artifact ${artifactId} omits a schema for non-HTML media type ${reference.mediaType}`,
        );
      } else {
        fail(
          `bundle artifact ${artifactId} references unpinned schema ${reference.schemaRef}`,
        );
      }
    }

    const actualBundleDigest = digestDesignflowManifest(bundle);
    assert(
      actualBundleDigest === bundle.bundleDigest,
      `Design Bundle Manifest bundleDigest mismatch: expected ${bundle.bundleDigest}, got ${actualBundleDigest}`,
    );

    const experience = requireArtifact<ExperienceContract>(
      artifacts,
      'experience',
      SCHEMA_REFS.experience,
      bundle,
    );
    const designSystemDelta = requireArtifact<DesignSystemDelta>(
      artifacts,
      'designSystemDelta',
      SCHEMA_REFS.designSystemDelta,
      bundle,
    );
    const capabilityRequirements = requireArtifact<CapabilityRequirements>(
      artifacts,
      'capabilityRequirements',
      SCHEMA_REFS.capabilityRequirements,
      bundle,
    );

    validateLineage(
      request,
      bundle,
      experience,
      designSystemDelta,
      capabilityRequirements,
    );
    validateCrossDocumentTrace(
      request,
      experience,
      designSystemDelta,
      capabilityRequirements,
    );
    validateTokenDocuments(bundleRoot, designSystemDelta);

    let decision: HumanDesignDecision | undefined;
    if (input.humanDecisionPath !== undefined) {
      const loadedDecision = readBundleJson(
        bundleRoot,
        input.humanDecisionPath,
        'Human Design Decision',
      );
      this.validateSchema(
        SCHEMA_REFS.humanDecision,
        loadedDecision.value,
        loadedDecision.filePath,
      );
      decision = loadedDecision.value as HumanDesignDecision;
      assert(
        decision.requestId === bundle.requestId &&
          decision.revisionId === bundle.revisionId &&
          decision.bundleDigest === bundle.bundleDigest,
        'Human Design Decision is bound to a different request, revision, or bundle digest',
      );
      if (decision.verdict === 'approve') {
        assert(
          experience.ambiguities.length === 0,
          'approved Design Bundle has unresolved Experience Contract ambiguities',
        );
      }
    }

    return {
      providerRef: this.lock.providerRef,
      providerCommit: this.lock.commit,
      contractDigest: this.lock.contractDigest,
      bundleId: bundle.bundleId,
      requestId: bundle.requestId,
      revisionId: bundle.revisionId,
      sourceDigest: bundle.sourceDigest,
      bundleDigest: bundle.bundleDigest,
      artifactIds: Object.keys(bundle.artifacts).sort(),
      capabilityIds: capabilityRequirements.capabilities
        .map((capability) => capability.id)
        .sort(),
      decisionId: decision?.decisionId,
      decisionVerdict: decision?.verdict,
      decisionSupersedesDecisionId: decision?.supersedesDecisionId,
    };
  }

  private validateSchema(
    schemaRef: string,
    value: JsonObject,
    source: string,
  ): void {
    const validate = this.validators.get(schemaRef);
    assert(validate !== undefined, `schema ${schemaRef} is not present in the reviewed lock`);
    if (!validate(value)) {
      const details = validate.errors
        ?.map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
        .join('; ');
      fail(`${source} does not conform to ${schemaRef}: ${details ?? 'unknown schema error'}`);
    }
  }
}

export function createDesignflowContractConsumer(
  options: DesignflowContractConsumerOptions,
): DesignflowContractConsumer {
  return new DesignflowContractConsumer(options);
}

export function validateDesignflowBundle(
  options: DesignflowContractConsumerOptions & DesignflowBundleInput,
): DesignflowContractResult {
  const { repositoryRoot, lockPath, bundleRoot, manifestPath, designRequestPath,
    humanDecisionPath } = options;
  const consumer = new DesignflowContractConsumer({ repositoryRoot, lockPath });
  return consumer.validateBundle({
    bundleRoot,
    manifestPath,
    designRequestPath,
    humanDecisionPath,
  });
}

/** Exercises the normative pinned fixture without any provider process or network. */
export function validatePinnedDesignflowFixture(
  repositoryRoot: string,
): DesignflowContractResult {
  const bundleRoot = path.join(
    repositoryRoot,
    'contracts',
    'designflow',
    'contract-v1.0.0-rc.1',
  );
  return validateDesignflowBundle({
    repositoryRoot,
    bundleRoot,
    manifestPath: 'contracts/v1/examples/design-bundle-manifest.example.json',
    designRequestPath: 'contracts/v1/examples/design-request.example.json',
    humanDecisionPath: 'contracts/v1/examples/human-design-decision.example.json',
  });
}

/** RFC 8785 serialization for JSON values represented by ECMAScript values. */
export function canonicalizeDesignflowJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'canonical JSON contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value, 'canonical JSON string');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeDesignflowJson(item)).join(',')}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertValidUnicode(key, 'canonical JSON member name');
        return `${JSON.stringify(key)}:${canonicalizeDesignflowJson(value[key]!)}`;
      })
      .join(',')}}`;
  }
  return fail(`canonical JSON contains unsupported ${typeof value}`);
}

export function digestDesignflowArtifact(
  content: Uint8Array | string,
  artifactMediaType: string,
): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const type = mediaType(artifactMediaType);
  if (type === JSON_MEDIA_TYPE || type.endsWith('+json')) {
    const value = parseJsonValue(bytes, 'JSON artifact');
    return sha256(Buffer.from(canonicalizeDesignflowJson(value), 'utf8'));
  }
  return sha256(bytes);
}

export function digestDesignflowManifest(
  manifest: JsonObject,
): string {
  const digestInput: JsonObject = { ...manifest };
  delete digestInput.bundleDigest;
  return sha256(Buffer.from(canonicalizeDesignflowJson(digestInput), 'utf8'));
}

function loadAndVerifyLock(
  repositoryRoot: string,
  lockPath: string,
): DesignflowContractLock {
  const loaded = readJson(lockPath, 'Designflow contract lock');
  const lock = parseLock(loaded.value);

  for (const [field, expected] of Object.entries(DESIGNFLOW_CONTRACT_PIN)) {
    assert(
      lock[field as keyof DesignflowContractLock] === expected,
      `Designflow contract lock ${field} is not the reviewed RC.1 pin`,
    );
  }
  assert(
    lock.digestAlgorithm === LOCK_DIGEST_ALGORITHM,
    `unsupported Designflow lock digest algorithm ${lock.digestAlgorithm}`,
  );

  const digestInput: JsonObject = {
    files: lock.files as unknown as JsonObject,
    provenance: lock.provenance as unknown as JsonObject,
  };
  const actualContractDigest = sha256(
    Buffer.from(canonicalizeDesignflowJson(digestInput), 'utf8'),
  );
  assert(
    actualContractDigest === lock.contractDigest,
    `Designflow contract lock digest mismatch: expected ${lock.contractDigest}, got ${actualContractDigest}`,
  );

  for (const [contractPath, entry] of Object.entries(lock.files)) {
    verifyLockedFile(repositoryRoot, entry, `locked contract file ${contractPath}`);
  }
  verifyLockedFile(repositoryRoot, lock.provenance.contract, 'contract provenance');
  verifyLockedFile(repositoryRoot, lock.provenance.schemas, 'schema provenance');

  const contractProvenance = readRepositoryJson(
    repositoryRoot,
    lock.provenance.contract.localPath,
    'contract provenance',
  ).value;
  assertExactKeys(contractProvenance, [
    'providerRef',
    'tagObject',
    'commit',
    'retrievedAt',
    'contractPath',
    'purpose',
  ], 'contract provenance');
  assert(
    contractProvenance.providerRef === lock.providerRef &&
      contractProvenance.tagObject === lock.tagObject &&
      contractProvenance.commit === lock.commit &&
      contractProvenance.contractPath === lock.contractPath,
    'contract provenance does not match the reviewed Designflow lock',
  );
  requireNonEmptyString(contractProvenance, 'retrievedAt', 'contract provenance');
  requireNonEmptyString(contractProvenance, 'purpose', 'contract provenance');

  const schemaProvenance = readRepositoryJson(
    repositoryRoot,
    lock.provenance.schemas.localPath,
    'schema provenance',
  ).value;
  assertExactKeys(schemaProvenance, [
    'schemaVersion',
    'provider',
    'providerCommit',
    'providerTagObject',
    'sourceDirectory',
    'normalization',
    'files',
  ], 'schema provenance');
  assert(
    schemaProvenance.schemaVersion === '1.0' &&
      schemaProvenance.provider === lock.providerRef &&
      schemaProvenance.providerCommit === lock.commit &&
      schemaProvenance.providerTagObject === lock.tagObject &&
      schemaProvenance.sourceDirectory === lock.contractPath,
    'schema provenance does not match the reviewed Designflow lock',
  );
  const provenanceFiles = requireObject(schemaProvenance.files, 'schema provenance files');
  const lockedSchemaFiles = Object.entries(lock.files)
    .filter(([contractPath]) => contractPath.endsWith('.schema.json'));
  assert(
    Object.keys(provenanceFiles).length === lockedSchemaFiles.length,
    'schema provenance file set differs from the Designflow lock',
  );
  for (const [contractPath, entry] of lockedSchemaFiles) {
    const name = path.posix.basename(contractPath);
    assert(
      provenanceFiles[name] === entry.digest,
      `schema provenance digest for ${name} differs from the Designflow lock`,
    );
  }

  return lock;
}

function loadValidators(
  repositoryRoot: string,
  lock: DesignflowContractLock,
): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('uri', {
    type: 'string',
    validate: isAbsoluteUri,
  });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: isRfc3339DateTime,
  });

  for (const [contractPath, entry] of Object.entries(lock.files)
    .filter(([contractPath]) => contractPath.endsWith('.schema.json'))
    .sort(([left], [right]) => left.localeCompare(right))) {
    const loaded = readRepositoryJson(
      repositoryRoot,
      entry.localPath,
      `schema ${contractPath}`,
    );
    ajv.addSchema(loaded.value as AnySchema);
  }

  const validators = new Map<string, ValidateFunction>();
  for (const schemaRef of Object.values(SCHEMA_REFS)) {
    const validator = ajv.getSchema(schemaRef);
    assert(validator !== undefined, `locked schemas do not provide ${schemaRef}`);
    validators.set(schemaRef, validator);
  }
  return validators;
}

function parseLock(value: JsonObject): DesignflowContractLock {
  assertExactKeys(value, [
    'schemaVersion',
    'providerRef',
    'tag',
    'tagObject',
    'commit',
    'contractPath',
    'sourceTree',
    'digestAlgorithm',
    'contractDigest',
    'provenance',
    'files',
  ], 'Designflow contract lock');

  const provenance = requireObject(value.provenance, 'Designflow lock provenance');
  assertExactKeys(provenance, ['contract', 'schemas'], 'Designflow lock provenance');
  const contractProvenance = parseLockedFile(
    provenance.contract,
    'Designflow lock contract provenance',
  );
  const schemaProvenance = parseLockedFile(
    provenance.schemas,
    'Designflow lock schema provenance',
  );
  const files = requireObject(value.files, 'Designflow lock files');
  assert(Object.keys(files).length > 0, 'Designflow contract lock has no files');
  const parsedFiles: Record<string, LockedFile> = {};
  for (const [contractPath, entry] of Object.entries(files)) {
    assert(
      contractPath.startsWith('contracts/v1/') && !contractPath.includes('\\'),
      `Designflow lock has invalid provider path ${contractPath}`,
    );
    parsedFiles[contractPath] = parseLockedFile(
      entry,
      `Designflow lock file ${contractPath}`,
    );
  }

  const lock: DesignflowContractLock = {
    schemaVersion: requireLiteral(value, 'schemaVersion', '1.0', 'Designflow contract lock'),
    providerRef: requireString(value, 'providerRef', 'Designflow contract lock'),
    tag: requireString(value, 'tag', 'Designflow contract lock'),
    tagObject: requireSha1(value, 'tagObject', 'Designflow contract lock'),
    commit: requireSha1(value, 'commit', 'Designflow contract lock'),
    contractPath: requireString(value, 'contractPath', 'Designflow contract lock'),
    sourceTree: requireString(value, 'sourceTree', 'Designflow contract lock'),
    digestAlgorithm: requireString(value, 'digestAlgorithm', 'Designflow contract lock'),
    contractDigest: requireDigest(value, 'contractDigest', 'Designflow contract lock'),
    provenance: {
      contract: contractProvenance,
      schemas: schemaProvenance,
    },
    files: parsedFiles,
  };
  assert(
    /^git-sha1:[0-9a-f]{40}$/.test(lock.sourceTree),
    'Designflow contract lock sourceTree is invalid',
  );
  return lock;
}

function parseLockedFile(value: JsonValue | undefined, label: string): LockedFile {
  const entry = requireObject(value, label);
  assertExactKeys(entry, ['localPath', 'digest'], label);
  const localPath = requireString(entry, 'localPath', label);
  assert(!path.isAbsolute(localPath), `${label} localPath must be repository-relative`);
  return {
    localPath,
    digest: requireDigest(entry, 'digest', label),
  };
}

function verifyLockedFile(
  repositoryRoot: string,
  entry: LockedFile,
  label: string,
): void {
  const filePath = resolveContainedFile(repositoryRoot, entry.localPath, label);
  const actual = sha256(readFile(filePath, label));
  assert(
    actual === entry.digest,
    `${label} digest mismatch: expected ${entry.digest}, got ${actual}`,
  );
}

function validateLineage(
  request: DesignRequest,
  bundle: DesignBundleManifest,
  experience: ExperienceContract,
  designSystemDelta: DesignSystemDelta,
  capabilityRequirements: CapabilityRequirements,
): void {
  for (const [label, document] of [
    ['Experience Contract', experience],
    ['Design System Delta', designSystemDelta],
    ['Capability Requirements', capabilityRequirements],
  ] as const) {
    assert(
      document.requestId === request.requestId &&
        document.requestId === bundle.requestId,
      `${label} requestId differs from the Design Request or bundle manifest`,
    );
    assert(
      document.revisionId === bundle.revisionId,
      `${label} revisionId differs from the bundle manifest`,
    );
  }
}

function validateCrossDocumentTrace(
  request: DesignRequest,
  experience: ExperienceContract,
  designSystemDelta: DesignSystemDelta,
  capabilityRequirements: CapabilityRequirements,
): void {
  assertUnique(request.requirements, 'Design Request requirements');
  assertUnique(experience.pagePurposes, 'Experience Contract page purposes');
  assertUnique(experience.tasks, 'Experience Contract tasks');
  assertUnique(experience.flows, 'Experience Contract flows');
  assertUnique(experience.effortBudgets, 'Experience Contract effort budgets');
  assertUnique(experience.regions, 'Experience Contract regions');
  assertUnique(experience.elements, 'Experience Contract elements');
  assertUnique(capabilityRequirements.capabilities, 'Capability Requirements');
  assertUnique(designSystemDelta.decisions, 'Design System decisions');
  assertUnique(designSystemDelta.componentDeltas, 'Design System component deltas');
  assertUnique(designSystemDelta.patternDeltas, 'Design System pattern deltas');

  const requirementIds = ids(request.requirements);
  const purposeIds = ids(experience.pagePurposes);
  const taskIds = ids(experience.tasks);
  const regionIds = ids(experience.regions);
  const elementIds = ids(experience.elements);
  const capabilityIds = ids(capabilityRequirements.capabilities);

  for (const purpose of experience.pagePurposes) {
    assertRefs(
      purpose.sourceRequirementIds,
      requirementIds,
      `page purpose ${purpose.id}`,
    );
  }
  for (const task of experience.tasks) {
    assertRefs([task.pagePurposeId], purposeIds, `task ${task.id}`);
    assertRefs(task.sourceRequirementIds, requirementIds, `task ${task.id}`);
  }

  const tasksWithFlows = new Set<string>();
  const stepIds = new Set<string>();
  for (const flow of experience.flows) {
    assertRefs([flow.taskId], taskIds, `flow ${flow.id}`);
    tasksWithFlows.add(flow.taskId);
    for (const step of flow.steps) {
      assert(!stepIds.has(step.id), `flow steps contain duplicate id ${step.id}`);
      stepIds.add(step.id);
      assertRefs(
        step.capabilityRequirementIds,
        capabilityIds,
        `flow step ${step.id}`,
      );
    }
  }

  const tasksWithEffortBudgets = new Set<string>();
  for (const budget of experience.effortBudgets) {
    assertRefs([budget.taskId], taskIds, `effort budget ${budget.id}`);
    tasksWithEffortBudgets.add(budget.taskId);
  }
  for (const taskId of taskIds) {
    assert(tasksWithFlows.has(taskId), `task ${taskId} has no flow`);
    assert(
      tasksWithEffortBudgets.has(taskId),
      `task ${taskId} has no effort budget`,
    );
  }

  for (const region of experience.regions) {
    assertRefs([region.pagePurposeId], purposeIds, `region ${region.id}`);
    assertRefs(region.supportsTaskIds, taskIds, `region ${region.id}`);
  }
  for (const element of experience.elements) {
    assertRefs([element.regionId], regionIds, `element ${element.id}`);
    assertRefs(element.supportsPurposeIds, purposeIds, `element ${element.id}`);
    assertRefs(element.supportsTaskIds, taskIds, `element ${element.id}`);
    assertRefs(
      element.sourceRequirementIds,
      requirementIds,
      `element ${element.id}`,
    );
  }
  for (const hierarchy of experience.attentionHierarchies) {
    assertRefs(
      [hierarchy.pagePurposeId],
      purposeIds,
      `attention hierarchy ${hierarchy.pagePurposeId}`,
    );
    for (const level of hierarchy.levels) {
      assertRefs(
        level.regionIds,
        regionIds,
        `attention hierarchy ${hierarchy.pagePurposeId} level ${level.level}`,
      );
      assertRefs(
        level.elementIds,
        elementIds,
        `attention hierarchy ${hierarchy.pagePurposeId} level ${level.level}`,
      );
    }
  }

  for (const decision of designSystemDelta.decisions) {
    assertRefs(
      decision.sourceRequirementIds,
      requirementIds,
      `Design System decision ${decision.id}`,
    );
  }
  for (const delta of designSystemDelta.componentDeltas) {
    assertRefs(
      delta.sourceRequirementIds,
      requirementIds,
      `component delta ${delta.id}`,
    );
  }
  for (const delta of designSystemDelta.patternDeltas) {
    assertRefs(
      delta.sourceRequirementIds,
      requirementIds,
      `pattern delta ${delta.id}`,
    );
  }
  for (const capability of capabilityRequirements.capabilities) {
    assertRefs(
      capability.sourceRequirementIds,
      requirementIds,
      `capability ${capability.id}`,
    );
    assertRefs(
      capability.sourceInteractionIds,
      stepIds,
      `capability ${capability.id}`,
    );
  }
}

function validateTokenDocuments(
  bundleRoot: string,
  designSystemDelta: DesignSystemDelta,
): void {
  for (const tokenDocument of designSystemDelta.tokenDocuments) {
    const tokenPath = resolveContainedFile(
      bundleRoot,
      tokenDocument.path,
      'Design System token document',
    );
    const bytes = readFile(tokenPath, 'Design System token document');
    const actual = digestDesignflowArtifact(
      bytes,
      'application/design-tokens+json',
    );
    assert(
      actual === tokenDocument.digest,
      `Design System token document digest mismatch: expected ${tokenDocument.digest}, got ${actual}`,
    );
    validateDesignTokens(parseJsonObject(bytes, 'Design System token document'));
  }
}

function validateDesignTokens(document: JsonObject): void {
  const tokenCount = validateTokenGroup(document, '', '');
  assert(tokenCount > 0, 'design token document contains no tokens');
}

function validateTokenGroup(
  group: JsonObject,
  location: string,
  inheritedType: string,
): number {
  let currentType = inheritedType;
  if ('$type' in group) {
    assert(
      typeof group.$type === 'string' && group.$type.trim().length > 0,
      `design token ${location || '<root>'} has an invalid $type`,
    );
    currentType = group.$type;
  }
  if ('$value' in group) {
    assert(
      currentType.length > 0,
      `design token ${location || '<root>'} has no inherited or local $type`,
    );
    assert(group.$value !== null, `design token ${location || '<root>'} has a null $value`);
    for (const key of Object.keys(group)) {
      assert(
        key.startsWith('$'),
        `design token ${location || '<root>'} mixes $value with child ${key}`,
      );
    }
    return 1;
  }

  let count = 0;
  for (const [key, child] of Object.entries(group)) {
    if (key.startsWith('$')) continue;
    assert(key.length > 0, `design token group ${location || '<root>'} has an empty child`);
    const childGroup = requireObject(
      child,
      `design token group ${location || '<root>'}.${key}`,
    );
    count += validateTokenGroup(
      childGroup,
      location.length > 0 ? `${location}.${key}` : key,
      currentType,
    );
  }
  return count;
}

function requireArtifact<T extends JsonObject>(
  artifacts: Map<string, JsonObject>,
  artifactId: string,
  expectedSchemaRef: string,
  manifest: DesignBundleManifest,
): T {
  const reference = manifest.artifacts[artifactId];
  assert(reference !== undefined, `Design Bundle has no ${artifactId} artifact`);
  assert(
    reference.schemaRef === expectedSchemaRef,
    `Design Bundle artifact ${artifactId} has unexpected schema ${reference.schemaRef}`,
  );
  const value = artifacts.get(artifactId);
  assert(value !== undefined, `Design Bundle artifact ${artifactId} was not parsed`);
  return value as T;
}

function assertUnique(items: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    assert(!seen.has(item.id), `${label} contain duplicate id ${item.id}`);
    seen.add(item.id);
  }
}

function ids(items: Array<{ id: string }>): Set<string> {
  return new Set(items.map((item) => item.id));
}

function assertRefs(values: string[], allowed: Set<string>, label: string): void {
  for (const value of values) {
    assert(allowed.has(value), `${label} references unknown id ${value}`);
  }
}

function readBundleJson(root: string, candidate: string, label: string): LoadedJson {
  const filePath = resolveContainedFile(root, candidate, label);
  const bytes = readFile(filePath, label);
  return {
    bytes,
    value: parseJsonObject(bytes, label),
    filePath,
  };
}

function readRepositoryJson(
  repositoryRoot: string,
  candidate: string,
  label: string,
): LoadedJson {
  const filePath = resolveContainedFile(repositoryRoot, candidate, label);
  const bytes = readFile(filePath, label);
  return {
    bytes,
    value: parseJsonObject(bytes, label),
    filePath,
  };
}

function readJson(filePath: string, label: string): LoadedJson {
  const bytes = readFile(filePath, label);
  return {
    bytes,
    value: parseJsonObject(bytes, label),
    filePath,
  };
}

function readFile(filePath: string, label: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    return fail(`${label} cannot be read: ${errorMessage(error)}`);
  }
}

function parseJsonObject(bytes: Uint8Array, label: string): JsonObject {
  const value = parseJsonValue(bytes, label);
  return requireObject(value, label);
}

function parseJsonValue(bytes: Uint8Array, label: string): JsonValue {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as JsonValue;
  } catch (error) {
    return fail(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function resolveContainedFile(root: string, candidate: string, label: string): string {
  const resolved = path.resolve(root, candidate);
  assert(isWithin(root, resolved), `${label} path escapes its root`);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    return fail(`${label} does not exist: ${errorMessage(error)}`);
  }
  assert(isWithin(root, real), `${label} resolves outside its root`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (error) {
    return fail(`${label} cannot be inspected: ${errorMessage(error)}`);
  }
  assert(stat.isFile(), `${label} is not a file`);
  return real;
}

function realDirectory(candidate: string, label: string): string {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(candidate));
  } catch (error) {
    return fail(`${label} does not exist: ${errorMessage(error)}`);
  }
  assert(fs.statSync(real).isDirectory(), `${label} is not a directory`);
  return real;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function mediaType(value: string): string {
  const parsed = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  assert(
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(parsed),
    `invalid artifact media type ${value}`,
  );
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isAbsoluteUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= maxDay;
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert(
        next >= 0xdc00 && next <= 0xdfff,
        `${label} contains an unpaired high surrogate`,
      );
      index += 1;
    } else {
      assert(
        code < 0xdc00 || code > 0xdfff,
        `${label} contains an unpaired low surrogate`,
      );
    }
  }
}

function requireObject(value: JsonValue | undefined, label: string): JsonObject {
  assert(isJsonObject(value), `${label} must be a JSON object`);
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  assert(
    typeof value === 'string' && value.trim().length > 0,
    `${label}.${key} must be a non-empty string`,
  );
  return value;
}

function requireNonEmptyString(object: JsonObject, key: string, label: string): void {
  requireString(object, key, label);
}

function requireLiteral<T extends string>(
  object: JsonObject,
  key: string,
  expected: T,
  label: string,
): T {
  assert(object[key] === expected, `${label}.${key} must equal ${expected}`);
  return expected;
}

function requireSha1(object: JsonObject, key: string, label: string): string {
  const value = requireString(object, key, label);
  assert(/^[0-9a-f]{40}$/.test(value), `${label}.${key} must be a lowercase SHA-1`);
  return value;
}

function requireDigest(object: JsonObject, key: string, label: string): string {
  const value = requireString(object, key, label);
  assert(
    /^sha256:[0-9a-f]{64}$/.test(value),
    `${label}.${key} must be a lowercase SHA-256 digest`,
  );
  return value;
}

function assertExactKeys(object: JsonObject, expected: string[], label: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} fields differ from the reviewed contract: expected ${wanted.join(', ')}, got ${actual.join(', ')}`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function fail(message: string): never {
  throw new DesignflowContractError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
