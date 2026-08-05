import fs from 'node:fs';
import path from 'node:path';
import { MIMEType, TextDecoder } from 'node:util';
import {
  Ajv2020,
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import { z } from 'zod';
import { repositoryPath } from '../runtime/roots.js';
import {
  digestDesignflowArtifact,
  digestDesignflowManifest,
  type DesignflowBundleInput,
} from './contract-consumer.js';

const DESIGNFLOW_SCHEMA_ROOT = repositoryPath(
  'contracts',
  'designflow',
  'contract-v1.0.0-rc.1',
  'contracts',
  'v1',
);

function loadPublishedSchema(name: string): AnySchemaObject {
  return JSON.parse(
    fs.readFileSync(path.join(DESIGNFLOW_SCHEMA_ROOT, name), 'utf8'),
  ) as AnySchemaObject;
}

const capabilityRequirementsJsonSchema = loadPublishedSchema(
  'capability-requirements.schema.json',
);
const commonJsonSchema = loadPublishedSchema('common.schema.json');
const designRequestJsonSchema = loadPublishedSchema('design-request.schema.json');
const designSystemDeltaJsonSchema = loadPublishedSchema('design-system-delta.schema.json');
const experienceContractJsonSchema = loadPublishedSchema('experience-contract.schema.json');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RELATIVE_ARTIFACT_PATH = /^(?!\/)(?!.*\.\.\/).+$/;

const NonEmptyString = z.string().min(1);
const Identifier = NonEmptyString.regex(IDENTIFIER);
const Sha256Digest = z.string().regex(SHA256);
const DateTime = z.string().datetime({ offset: true });

const ExternalReferenceSchema = z.object({
  provider: NonEmptyString,
  externalId: NonEmptyString,
  uri: z.string().url().optional(),
  revision: NonEmptyString.optional(),
  digest: Sha256Digest.optional(),
}).strict();

export const DesignflowArtifactReferenceSchema = z.object({
  path: NonEmptyString.regex(RELATIVE_ARTIFACT_PATH),
  digest: Sha256Digest,
  mediaType: NonEmptyString,
  schemaRef: NonEmptyString,
}).strict();
export type DesignflowArtifactReference = z.infer<typeof DesignflowArtifactReferenceSchema>;

export const DesignBundleManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  bundleId: Identifier,
  requestId: Identifier,
  revisionId: Identifier,
  previousRevisionId: Identifier.nullable(),
  sourceDigest: Sha256Digest,
  designSystemBaseRevision: ExternalReferenceSchema.nullable(),
  artifacts: z.object({
    experience: DesignflowArtifactReferenceSchema,
    designSystemDelta: DesignflowArtifactReferenceSchema,
    designTokens: DesignflowArtifactReferenceSchema.optional(),
    capabilityRequirements: DesignflowArtifactReferenceSchema,
    preview: DesignflowArtifactReferenceSchema,
  }).strict(),
  authorInvocationRefs: z.array(ExternalReferenceSchema),
  bundleDigest: Sha256Digest,
  createdAt: DateTime,
}).strict();
export type DesignBundleManifest = z.infer<typeof DesignBundleManifestSchema>;

export const HumanDesignDecisionSchema = z.object({
  schemaVersion: z.literal('1.0'),
  decisionId: Identifier,
  requestId: Identifier,
  revisionId: Identifier,
  bundleDigest: Sha256Digest,
  verdict: z.enum(['approve', 'request-changes', 'reject']),
  rationale: NonEmptyString,
  decidedBy: z.object({
    provider: NonEmptyString,
    subject: NonEmptyString,
    displayName: z.string().optional(),
  }).strict(),
  decidedAt: DateTime,
  supersedesDecisionId: Identifier.nullable(),
}).strict();
export type HumanDesignDecision = z.infer<typeof HumanDesignDecisionSchema>;

export type DesignflowArtifactContent = string | Uint8Array;
export type DesignflowArtifactBodies =
  | Readonly<Record<string, DesignflowArtifactContent | undefined>>
  | ReadonlyMap<string, DesignflowArtifactContent>;

export interface DesignDecisionGateInput {
  /** A decoded manifest or its UTF-8 JSON representation. */
  readonly manifest: unknown;
  /** The Design Request bytes whose digest is recorded as manifest.sourceDigest. */
  readonly source: DesignflowArtifactContent;
  /** Artifact bytes keyed by the provider-owned path recorded in the manifest. */
  readonly artifacts: DesignflowArtifactBodies;
  /** The latest Human Design Decision, or null/undefined when no decision exists. */
  readonly decision?: unknown | null;
}

export const DESIGN_DECISION_GATE_REASON_CODES = [
  'manifest-schema-invalid',
  'source-schema-invalid',
  'source-digest-mismatch',
  'source-lineage-mismatch',
  'artifact-missing',
  'artifact-path-duplicate',
  'artifact-contract-mismatch',
  'artifact-schema-invalid',
  'artifact-digest-mismatch',
  'artifact-lineage-mismatch',
  'unresolved-ambiguity',
  'bundle-digest-mismatch',
  'decision-missing',
  'decision-schema-invalid',
  'decision-request-changes',
  'decision-rejected',
  'stale-approval',
] as const;
export type DesignDecisionGateReasonCode =
  (typeof DESIGN_DECISION_GATE_REASON_CODES)[number];

export interface DesignDecisionGateReason {
  readonly code: DesignDecisionGateReasonCode;
  readonly message: string;
  readonly artifact?: string;
}

export interface DesignDecisionGateResult {
  readonly status: 'approved' | 'needs-human-review';
  readonly requestId: string | null;
  readonly revisionId: string | null;
  readonly bundleDigest: string | null;
  readonly decisionId: string | null;
  readonly supersedesDecisionId: string | null;
  readonly reasons: readonly DesignDecisionGateReason[];
}

const DESIGN_REQUEST_SCHEMA_REF = 'urn:designflow:schema:v1:design-request';
const EXPERIENCE_SCHEMA_REF = 'urn:designflow:schema:v1:experience-contract';
const DESIGN_SYSTEM_DELTA_SCHEMA_REF = 'urn:designflow:schema:v1:design-system-delta';
const CAPABILITY_REQUIREMENTS_SCHEMA_REF =
  'urn:designflow:schema:v1:capability-requirements';
const DESIGN_TOKENS_SCHEMA_REF = 'https://www.designtokens.org/TR/2025.10/format/';

interface ArtifactContract {
  readonly mediaType: string;
  readonly schemaRef: string;
  readonly schemaValidator: ValidateFunction<unknown> | null;
  readonly lineaged: boolean;
}

const schemaCompiler = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
schemaCompiler.addFormat('date-time', {
  type: 'string',
  validate: isRfc3339DateTime,
});
schemaCompiler.addFormat('uri', {
  type: 'string',
  validate: isAbsoluteUri,
});
for (const schema of [
  commonJsonSchema,
  designRequestJsonSchema,
  experienceContractJsonSchema,
  designSystemDeltaJsonSchema,
  capabilityRequirementsJsonSchema,
]) {
  schemaCompiler.addSchema(schema as AnySchemaObject);
}

const validateDesignRequest = requireSchema(DESIGN_REQUEST_SCHEMA_REF);
const ARTIFACT_CONTRACTS: Readonly<Record<string, ArtifactContract>> = Object.freeze({
  experience: {
    mediaType: 'application/json',
    schemaRef: EXPERIENCE_SCHEMA_REF,
    schemaValidator: requireSchema(EXPERIENCE_SCHEMA_REF),
    lineaged: true,
  },
  designSystemDelta: {
    mediaType: 'application/json',
    schemaRef: DESIGN_SYSTEM_DELTA_SCHEMA_REF,
    schemaValidator: requireSchema(DESIGN_SYSTEM_DELTA_SCHEMA_REF),
    lineaged: true,
  },
  designTokens: {
    mediaType: 'application/design-tokens+json',
    schemaRef: DESIGN_TOKENS_SCHEMA_REF,
    schemaValidator: null,
    lineaged: false,
  },
  capabilityRequirements: {
    mediaType: 'application/json',
    schemaRef: CAPABILITY_REQUIREMENTS_SCHEMA_REF,
    schemaValidator: requireSchema(CAPABILITY_REQUIREMENTS_SCHEMA_REF),
    lineaged: true,
  },
  preview: {
    mediaType: 'text/html',
    schemaRef: 'none',
    schemaValidator: null,
    lineaged: false,
  },
});

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Computes the Designflow artifact digest. JSON media types are canonicalized
 * with RFC 8785 before SHA-256; non-JSON artifacts are hashed byte-for-byte.
 */
export function computeDesignflowArtifactDigest(
  content: DesignflowArtifactContent,
  mediaType: string,
): string {
  return digestDesignflowArtifact(content, mediaType);
}

/**
 * Computes bundleDigest from the manifest after removing only its top-level
 * bundleDigest property, matching the pinned Designflow RC fixture.
 */
export function computeDesignflowBundleDigest(manifest: unknown): string {
  const document = parseJsonDocument(manifest);
  if (!isJsonObject(document)) {
    throw new TypeError('Design Bundle manifest must be a JSON object');
  }
  return digestDesignflowManifest(
    document as Parameters<typeof digestDesignflowManifest>[0],
  );
}

/**
 * Evaluates a provider-neutral candidate. Candidate defects are represented as
 * a deterministic fail-closed result rather than exceptions so callers can
 * project every failure to needs-human-review before queueing.
 */
export function evaluateDesignDecisionGate(
  input: DesignDecisionGateInput,
): DesignDecisionGateResult {
  const reasons: DesignDecisionGateReason[] = [];
  let manifestDocument: unknown;
  try {
    manifestDocument = parseJsonDocument(input.manifest);
  } catch {
    return reviewResult(null, null, null, null, null, [{
      code: 'manifest-schema-invalid',
      message: 'Design Bundle manifest is not valid UTF-8 JSON',
    }]);
  }

  const manifestResult = DesignBundleManifestSchema.safeParse(manifestDocument);
  if (!manifestResult.success) {
    return reviewResult(null, null, null, null, null, [{
      code: 'manifest-schema-invalid',
      message: `Design Bundle manifest schema validation failed: ${
        formatZodIssues(manifestResult.error.issues)
      }`,
    }]);
  }
  const manifest = manifestResult.data;

  validateSource(input.source, manifest, reasons);
  validateArtifacts(input.artifacts, manifest, reasons);

  try {
    const computedBundleDigest = computeDesignflowBundleDigest(manifestDocument);
    if (computedBundleDigest !== manifest.bundleDigest) {
      reasons.push({
        code: 'bundle-digest-mismatch',
        message: `bundleDigest is ${manifest.bundleDigest}, computed ${computedBundleDigest}`,
      });
    }
  } catch {
    reasons.push({
      code: 'bundle-digest-mismatch',
      message: 'Design Bundle manifest could not be RFC 8785 canonicalized',
    });
  }

  const decision = validateDecision(input.decision, manifest, reasons);
  if (reasons.length !== 0) {
    return reviewResult(
      manifest.requestId,
      manifest.revisionId,
      manifest.bundleDigest,
      decision?.decisionId ?? null,
      decision?.supersedesDecisionId ?? null,
      reasons,
    );
  }

  return {
    status: 'approved',
    requestId: manifest.requestId,
    revisionId: manifest.revisionId,
    bundleDigest: manifest.bundleDigest,
    decisionId: decision?.decisionId ?? null,
    supersedesDecisionId: decision?.supersedesDecisionId ?? null,
    reasons: [],
  };
}

/**
 * Materializes the exact files addressed by the provider-neutral bundle input and
 * evaluates WF-DF-004 over their raw bytes. Missing/unsafe optional inputs are
 * represented to the gate as missing instead of being trusted or silently skipped.
 */
export function evaluateMaterializedDesignDecisionGate(
  input: DesignflowBundleInput,
): DesignDecisionGateResult {
  const bundleRoot = fs.realpathSync(input.bundleRoot);
  if (!fs.statSync(bundleRoot).isDirectory()) {
    throw new TypeError(`Designflow bundle root is not a directory: ${input.bundleRoot}`);
  }
  const manifest = readRequiredMaterializedFile(
    bundleRoot,
    input.manifestPath,
    'Design Bundle manifest',
  );
  const source = readOptionalMaterializedFile(
    bundleRoot,
    input.designRequestPath,
  ) ?? Buffer.alloc(0);
  const artifacts: Record<string, Buffer | undefined> = {};

  try {
    const document = JSON.parse(utf8Decoder.decode(manifest)) as unknown;
    const parsed = DesignBundleManifestSchema.safeParse(document);
    if (parsed.success) {
      for (const reference of Object.values(parsed.data.artifacts)) {
        if (reference !== undefined) {
          artifacts[reference.path] = readOptionalMaterializedFile(
            bundleRoot,
            reference.path,
          );
        }
      }
    }
  } catch {
    // evaluateDesignDecisionGate deterministically reports malformed manifest bytes.
  }

  const decision = input.humanDecisionPath === undefined
    ? null
    : readOptionalMaterializedFile(bundleRoot, input.humanDecisionPath) ?? null;
  return evaluateDesignDecisionGate({
    manifest,
    source,
    artifacts,
    decision,
  });
}

function validateSource(
  source: DesignflowArtifactContent,
  manifest: DesignBundleManifest,
  reasons: DesignDecisionGateReason[],
): void {
  let inspected: InspectedArtifact;
  try {
    inspected = inspectArtifact(source, 'application/json');
  } catch {
    reasons.push({
      code: 'source-schema-invalid',
      message: 'Design Request is not valid UTF-8 JSON',
    });
    return;
  }

  if (inspected.digest !== manifest.sourceDigest) {
    reasons.push({
      code: 'source-digest-mismatch',
      message: `sourceDigest is ${manifest.sourceDigest}, computed ${inspected.digest}`,
    });
  }

  const sourceDocument = inspected.jsonValue;
  if (!validateDesignRequest(sourceDocument)) {
    reasons.push({
      code: 'source-schema-invalid',
      message: `Design Request schema validation failed: ${
        formatAjvErrors(validateDesignRequest.errors)
      }`,
    });
    return;
  }
  if (
    !isJsonObject(sourceDocument)
    || sourceDocument.requestId !== manifest.requestId
  ) {
    reasons.push({
      code: 'source-lineage-mismatch',
      message: 'Design Request requestId does not match the Design Bundle manifest',
    });
  }
}

function validateArtifacts(
  bodies: DesignflowArtifactBodies,
  manifest: DesignBundleManifest,
  reasons: DesignDecisionGateReason[],
): void {
  const seenPaths = new Set<string>();
  const entries = Object.entries(manifest.artifacts)
    .sort(([left], [right]) => compareUtf16(left, right));

  for (const [artifactKey, reference] of entries) {
    if (seenPaths.has(reference.path)) {
      reasons.push({
        code: 'artifact-path-duplicate',
        artifact: artifactKey,
        message: `Artifact path ${reference.path} is referenced more than once`,
      });
    }
    seenPaths.add(reference.path);

    const contract = ARTIFACT_CONTRACTS[artifactKey];
    if (contract === undefined) {
      reasons.push({
        code: 'artifact-contract-mismatch',
        artifact: artifactKey,
        message: `Artifact ${artifactKey} is not part of Designflow contract v1`,
      });
      continue;
    }

    let mediaType = '';
    try {
      mediaType = new MIMEType(reference.mediaType).essence;
    } catch {
      // The mismatch below deliberately gives all invalid media types one result.
    }
    if (
      mediaType !== contract.mediaType
      || reference.schemaRef !== contract.schemaRef
    ) {
      reasons.push({
        code: 'artifact-contract-mismatch',
        artifact: artifactKey,
        message: `Artifact ${artifactKey} mediaType/schemaRef does not match contract v1`,
      });
    }

    const content = artifactBody(bodies, reference.path);
    if (content === undefined) {
      reasons.push({
        code: 'artifact-missing',
        artifact: artifactKey,
        message: `Artifact ${artifactKey} is missing at ${reference.path}`,
      });
      continue;
    }

    let inspected: InspectedArtifact;
    try {
      inspected = inspectArtifact(content, reference.mediaType);
    } catch {
      reasons.push({
        code: 'artifact-schema-invalid',
        artifact: artifactKey,
        message: `Artifact ${artifactKey} cannot be decoded for ${reference.mediaType}`,
      });
      continue;
    }

    if (inspected.digest !== reference.digest) {
      reasons.push({
        code: 'artifact-digest-mismatch',
        artifact: artifactKey,
        message: `Artifact ${artifactKey} digest is ${reference.digest}, computed ${inspected.digest}`,
      });
    }

    if (contract.schemaValidator !== null) {
      if (!contract.schemaValidator(inspected.jsonValue)) {
        reasons.push({
          code: 'artifact-schema-invalid',
          artifact: artifactKey,
          message: `Artifact ${artifactKey} schema validation failed: ${
            formatAjvErrors(contract.schemaValidator.errors)
          }`,
        });
        continue;
      }
    }

    if (contract.lineaged) {
      validateArtifactLineage(
        artifactKey,
        inspected.jsonValue,
        manifest,
        reasons,
      );
    }
  }
}

function validateArtifactLineage(
  artifactKey: string,
  value: unknown,
  manifest: DesignBundleManifest,
  reasons: DesignDecisionGateReason[],
): void {
  if (
    !isJsonObject(value)
    || value.requestId !== manifest.requestId
    || value.revisionId !== manifest.revisionId
  ) {
    reasons.push({
      code: 'artifact-lineage-mismatch',
      artifact: artifactKey,
      message: `Artifact ${artifactKey} requestId/revisionId does not match the manifest`,
    });
  }

  if (
    isJsonObject(value)
    && Object.hasOwn(value, 'ambiguities')
    && (!Array.isArray(value.ambiguities) || value.ambiguities.length !== 0)
  ) {
    reasons.push({
      code: 'unresolved-ambiguity',
      artifact: artifactKey,
      message: `Artifact ${artifactKey} contains unresolved ambiguities`,
    });
  }
}

function validateDecision(
  candidate: unknown | null | undefined,
  manifest: DesignBundleManifest,
  reasons: DesignDecisionGateReason[],
): HumanDesignDecision | null {
  if (candidate === null || candidate === undefined) {
    reasons.push({
      code: 'decision-missing',
      message: 'No Human Design Decision exists for this Design Bundle',
    });
    return null;
  }

  let decisionDocument: unknown;
  try {
    decisionDocument = parseJsonDocument(candidate);
  } catch {
    reasons.push({
      code: 'decision-schema-invalid',
      message: 'Human Design Decision is not valid UTF-8 JSON',
    });
    return null;
  }
  const decisionResult = HumanDesignDecisionSchema.safeParse(decisionDocument);
  if (!decisionResult.success) {
    reasons.push({
      code: 'decision-schema-invalid',
      message: `Human Design Decision schema validation failed: ${
        formatZodIssues(decisionResult.error.issues)
      }`,
    });
    return null;
  }

  const decision = decisionResult.data;
  if (decision.verdict === 'request-changes') {
    reasons.push({
      code: 'decision-request-changes',
      message: 'Human Design Decision requests changes',
    });
  } else if (decision.verdict === 'reject') {
    reasons.push({
      code: 'decision-rejected',
      message: 'Human Design Decision rejects this Design Bundle',
    });
  }

  const mismatches: string[] = [];
  if (decision.requestId !== manifest.requestId) {
    mismatches.push('requestId');
  }
  if (decision.revisionId !== manifest.revisionId) {
    mismatches.push('revisionId');
  }
  if (decision.bundleDigest !== manifest.bundleDigest) {
    mismatches.push('bundleDigest');
  }
  if (mismatches.length !== 0) {
    reasons.push({
      code: 'stale-approval',
      message: `Human Design Decision is stale for: ${mismatches.join(', ')}`,
    });
  }
  return decision;
}

interface InspectedArtifact {
  readonly digest: string;
  readonly jsonValue?: unknown;
}

function inspectArtifact(
  content: DesignflowArtifactContent,
  mediaType: string,
): InspectedArtifact {
  const bytes = contentBytes(content);
  const essence = new MIMEType(mediaType).essence;
  const digest = digestDesignflowArtifact(bytes, mediaType);
  if (essence === 'application/json' || essence.endsWith('+json')) {
    const value = JSON.parse(utf8Decoder.decode(bytes)) as unknown;
    return {
      digest,
      jsonValue: value,
    };
  }
  return {
    digest,
  };
}

function parseJsonDocument(input: unknown): unknown {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return JSON.parse(utf8Decoder.decode(contentBytes(input))) as unknown;
  }
  return input;
}

function contentBytes(content: DesignflowArtifactContent): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function readRequiredMaterializedFile(
  bundleRoot: string,
  filePath: string,
  label: string,
): Buffer {
  const body = readOptionalMaterializedFile(bundleRoot, filePath);
  if (body === undefined) {
    throw new TypeError(`${label} is missing or outside the bundle root: ${filePath}`);
  }
  return body;
}

function readOptionalMaterializedFile(
  bundleRoot: string,
  filePath: string,
): Buffer | undefined {
  const candidate = path.resolve(bundleRoot, filePath);
  if (!isContainedPath(bundleRoot, candidate)) return undefined;
  try {
    const real = fs.realpathSync(candidate);
    if (!isContainedPath(bundleRoot, real) || !fs.statSync(real).isFile()) {
      return undefined;
    }
    return fs.readFileSync(real);
  } catch {
    return undefined;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

function artifactBody(
  bodies: DesignflowArtifactBodies,
  path: string,
): DesignflowArtifactContent | undefined {
  if (isReadonlyMap(bodies)) {
    return bodies.get(path);
  }
  return Object.hasOwn(bodies, path) ? bodies[path] : undefined;
}

function isReadonlyMap(
  value: DesignflowArtifactBodies,
): value is ReadonlyMap<string, DesignflowArtifactContent> {
  return typeof (value as ReadonlyMap<string, DesignflowArtifactContent>).get === 'function';
}

function requireSchema(schemaRef: string): ValidateFunction<unknown> {
  const validator = schemaCompiler.getSchema<unknown>(schemaRef);
  if (validator === undefined) {
    throw new Error(`Pinned Designflow schema is unavailable: ${schemaRef}`);
  }
  return validator;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'unknown schema error';
  }
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
    .sort(compareUtf16)
    .join('; ');
}

function formatZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`)
    .sort(compareUtf16)
    .join('; ');
}

function reviewResult(
  requestId: string | null,
  revisionId: string | null,
  bundleDigest: string | null,
  decisionId: string | null,
  supersedesDecisionId: string | null,
  reasons: readonly DesignDecisionGateReason[],
): DesignDecisionGateResult {
  return {
    status: 'needs-human-review',
    requestId,
    revisionId,
    bundleDigest,
    decisionId,
    supersedesDecisionId,
    reasons,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length !== 0;
  } catch {
    return false;
  }
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i
    .exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 60
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return false;
  }
  return true;
}
