import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  digestDesignflowArtifact,
  type DesignflowBundleInput,
  type DesignflowContractConsumer,
  type DesignflowContractResult,
} from './contract-consumer.js';

export type DesignflowJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DesignflowJsonValue[]
  | { readonly [key: string]: DesignflowJsonValue };

/** The only domain input accepted by a Designflow provider. */
export interface DesignflowDesignRequest {
  readonly schemaVersion: '1.0';
  readonly requestId: string;
  readonly [key: string]: DesignflowJsonValue;
}

/** Transport-neutral identity of one validated Design Bundle manifest. */
export interface DesignflowBundleReference {
  readonly uri: string;
  readonly bundleId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly bundleDigest: string;
}

/** Transport-neutral identity of a decision bound to the referenced bundle. */
export interface DesignflowDecisionReference {
  readonly uri: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly bundleDigest: string;
}

/** The only successful domain output exposed by a Designflow provider. */
export interface DesignflowProviderReferences {
  readonly bundle: DesignflowBundleReference;
  readonly decision: DesignflowDecisionReference | null;
}

/**
 * Provider-neutral domain port. A future CLI or HTTP implementation may materialize
 * and validate artifacts however it needs without changing this interface.
 */
export interface DesignflowProvider {
  provide(request: DesignflowDesignRequest): Promise<DesignflowProviderReferences>;
}

export class DesignflowProviderUnavailableError extends Error {
  override readonly name = 'DesignflowProviderUnavailableError';
  readonly code = 'designflow-provider-unavailable';

  constructor(
    readonly requestId: string,
    message = 'Designflow provider is unavailable',
  ) {
    super(`${message} (requestId=${requestId})`);
  }
}

export class DesignflowProviderInvalidResponseError extends Error {
  override readonly name = 'DesignflowProviderInvalidResponseError';
  readonly code = 'designflow-provider-invalid-response';

  constructor(
    readonly requestId: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Designflow provider response is invalid for ${requestId}: ${detail}`, options);
  }
}

export class DesignflowProviderFixtureError extends Error {
  override readonly name = 'DesignflowProviderFixtureError';
}

export interface AvailableDesignflowProviderFixture {
  readonly kind: 'available';
  readonly requestId: string;
  readonly requestDigest: string;
  /**
   * Adapter-private local materialization. It is consumed before the port returns
   * and is never exposed in DesignflowProviderReferences.
   */
  readonly materialization: DesignflowBundleInput;
}

export interface UnavailableDesignflowProviderFixture {
  readonly kind: 'unavailable';
  readonly requestId: string;
  readonly requestDigest: string;
  readonly message: string;
}

export type DesignflowProviderFixture =
  | AvailableDesignflowProviderFixture
  | UnavailableDesignflowProviderFixture;

type ContractConsumer = Pick<DesignflowContractConsumer, 'validateBundle'>;

export interface InMemoryDesignflowProviderOptions {
  readonly consumer: ContractConsumer;
  readonly fixtures: readonly DesignflowProviderFixture[];
}

/**
 * Deterministic in-memory adapter used by unit/domain tests. Fixtures select an
 * exact canonical Design Request, so a requestId collision cannot replay a stale
 * bundle created from different request content.
 */
export class InMemoryDesignflowProvider implements DesignflowProvider {
  private readonly consumer: ContractConsumer;
  private readonly fixtures = new Map<string, DesignflowProviderFixture>();

  constructor(options: InMemoryDesignflowProviderOptions) {
    this.consumer = options.consumer;
    for (const candidate of options.fixtures) {
      const fixture = normalizeFixture(candidate);
      const key = fixtureKey(fixture.requestId, fixture.requestDigest);
      if (this.fixtures.has(key)) {
        throw new DesignflowProviderFixtureError(
          `duplicate Designflow provider fixture for ${fixture.requestId} and ${fixture.requestDigest}`,
        );
      }
      this.fixtures.set(key, fixture);
    }
  }

  async provide(
    request: DesignflowDesignRequest,
  ): Promise<DesignflowProviderReferences> {
    validateDesignRequestEnvelope(request);
    const requestDigest = digestDesignflowRequest(request);
    const fixture = this.fixtures.get(fixtureKey(request.requestId, requestDigest));
    if (fixture === undefined) {
      throw new DesignflowProviderUnavailableError(
        request.requestId,
        'Designflow provider has no response for the exact Design Request',
      );
    }
    if (fixture.kind === 'unavailable') {
      throw new DesignflowProviderUnavailableError(
        request.requestId,
        fixture.message,
      );
    }
    return validateAndReference(
      this.consumer,
      request.requestId,
      requestDigest,
      fixture.materialization,
    );
  }
}

export interface FileDesignflowProviderOptions {
  readonly consumer: ContractConsumer;
  /** JSON fixture catalog; it is parsed once and never watched or remotely refreshed. */
  readonly fixturePath: string;
  /** Base for catalog bundleRoot values; defaults to the catalog directory. */
  readonly baseDirectory?: string;
}

/**
 * File-backed fixture adapter. The catalog contains only request digests,
 * availability, and local bundle materialization references—never CLI argv,
 * provider database state, or runtime SDK types.
 */
export class FileDesignflowProvider implements DesignflowProvider {
  private readonly delegate: InMemoryDesignflowProvider;

  constructor(options: FileDesignflowProviderOptions) {
    const fixturePath = existingFile(options.fixturePath, 'Designflow fixture catalog');
    const baseDirectory = existingDirectory(
      options.baseDirectory ?? path.dirname(fixturePath),
      'Designflow fixture base directory',
    );
    const fixtures = parseFixtureCatalog(
      readJson(fixturePath, 'Designflow fixture catalog'),
      baseDirectory,
    );
    this.delegate = new InMemoryDesignflowProvider({
      consumer: options.consumer,
      fixtures,
    });
  }

  provide(request: DesignflowDesignRequest): Promise<DesignflowProviderReferences> {
    return this.delegate.provide(request);
  }
}

/** Canonical input identity used by both fixture adapters. */
export function digestDesignflowRequest(request: DesignflowDesignRequest): string {
  validateDesignRequestEnvelope(request);
  assertJsonValue(request, 'Design Request', new Set<object>());
  const serialized = JSON.stringify(request);
  if (serialized === undefined) {
    throw new TypeError('Design Request is not JSON-serializable');
  }
  return digestDesignflowArtifact(serialized, 'application/json');
}

function validateAndReference(
  consumer: ContractConsumer,
  requestId: string,
  requestDigest: string,
  materialization: DesignflowBundleInput,
): DesignflowProviderReferences {
  let result: DesignflowContractResult;
  try {
    result = consumer.validateBundle(materialization);
  } catch (error) {
    throw new DesignflowProviderInvalidResponseError(
      requestId,
      errorMessage(error),
      { cause: error },
    );
  }

  if (result.requestId !== requestId) {
    throw new DesignflowProviderInvalidResponseError(
      requestId,
      `bundle requestId is ${result.requestId}`,
    );
  }
  if (result.sourceDigest !== requestDigest) {
    throw new DesignflowProviderInvalidResponseError(
      requestId,
      `bundle sourceDigest ${result.sourceDigest} does not match input ${requestDigest}`,
    );
  }

  const bundle: DesignflowBundleReference = Object.freeze({
    uri: materializedFileUri(
      materialization.bundleRoot,
      materialization.manifestPath,
      'Design Bundle Manifest',
    ),
    bundleId: result.bundleId,
    requestId: result.requestId,
    revisionId: result.revisionId,
    bundleDigest: result.bundleDigest,
  });

  let decision: DesignflowDecisionReference | null = null;
  if (materialization.humanDecisionPath !== undefined) {
    if (result.decisionId === undefined) {
      throw new DesignflowProviderInvalidResponseError(
        requestId,
        'consumer did not return the materialized decision identity',
      );
    }
    decision = Object.freeze({
      uri: materializedFileUri(
        materialization.bundleRoot,
        materialization.humanDecisionPath,
        'Human Design Decision',
      ),
      decisionId: result.decisionId,
      requestId: result.requestId,
      revisionId: result.revisionId,
      bundleDigest: result.bundleDigest,
    });
  }

  return Object.freeze({ bundle, decision });
}

function normalizeFixture(
  fixture: DesignflowProviderFixture,
): DesignflowProviderFixture {
  requireFixtureIdentity(fixture);
  if (fixture.kind === 'unavailable') {
    if (fixture.message.trim().length === 0) {
      throw new DesignflowProviderFixtureError(
        `unavailable fixture ${fixture.requestId} has an empty message`,
      );
    }
    return Object.freeze({
      kind: fixture.kind,
      requestId: fixture.requestId,
      requestDigest: fixture.requestDigest,
      message: fixture.message,
    });
  }

  const materialization = normalizeMaterialization(fixture.materialization);
  return Object.freeze({
    kind: fixture.kind,
    requestId: fixture.requestId,
    requestDigest: fixture.requestDigest,
    materialization: Object.freeze(materialization),
  });
}

function normalizeMaterialization(
  materialization: DesignflowBundleInput,
): DesignflowBundleInput {
  const bundleRoot = requireNonEmptyString(
    materialization.bundleRoot,
    'fixture materialization.bundleRoot',
  );
  const manifestPath = requireNonEmptyString(
    materialization.manifestPath,
    'fixture materialization.manifestPath',
  );
  const designRequestPath = requireNonEmptyString(
    materialization.designRequestPath,
    'fixture materialization.designRequestPath',
  );
  const humanDecisionPath = materialization.humanDecisionPath === undefined
    ? undefined
    : requireNonEmptyString(
      materialization.humanDecisionPath,
      'fixture materialization.humanDecisionPath',
    );
  return {
    bundleRoot: path.resolve(bundleRoot),
    manifestPath,
    designRequestPath,
    humanDecisionPath,
  };
}

function requireFixtureIdentity(fixture: DesignflowProviderFixture): void {
  requireNonEmptyString(fixture.requestId, 'fixture requestId');
  if (!/^sha256:[0-9a-f]{64}$/.test(fixture.requestDigest)) {
    throw new DesignflowProviderFixtureError(
      `fixture ${fixture.requestId} has an invalid requestDigest`,
    );
  }
}

function fixtureKey(requestId: string, requestDigest: string): string {
  return `${requestId}\0${requestDigest}`;
}

function parseFixtureCatalog(
  candidate: unknown,
  baseDirectory: string,
): DesignflowProviderFixture[] {
  const catalog = requireRecord(candidate, 'Designflow fixture catalog');
  requireExactKeys(catalog, ['schemaVersion', 'fixtures'], 'Designflow fixture catalog');
  if (catalog.schemaVersion !== '1.0') {
    throw new DesignflowProviderFixtureError(
      'Designflow fixture catalog schemaVersion must equal 1.0',
    );
  }
  if (!Array.isArray(catalog.fixtures)) {
    throw new DesignflowProviderFixtureError(
      'Designflow fixture catalog fixtures must be an array',
    );
  }
  return catalog.fixtures.map((entry, index) =>
    parseCatalogFixture(entry, index, baseDirectory));
}

function parseCatalogFixture(
  candidate: unknown,
  index: number,
  baseDirectory: string,
): DesignflowProviderFixture {
  const label = `Designflow fixture catalog entry ${index}`;
  const fixture = requireRecord(candidate, label);
  const kind = fixture.kind;
  if (kind === 'unavailable') {
    requireExactKeys(
      fixture,
      ['kind', 'requestId', 'requestDigest', 'message'],
      label,
    );
    return {
      kind,
      requestId: recordString(fixture, 'requestId', label),
      requestDigest: recordString(fixture, 'requestDigest', label),
      message: recordString(fixture, 'message', label),
    };
  }
  if (kind !== 'available') {
    throw new DesignflowProviderFixtureError(
      `${label}.kind must equal available or unavailable`,
    );
  }
  requireExactKeys(
    fixture,
    ['kind', 'requestId', 'requestDigest', 'materialization'],
    label,
  );
  const materialization = requireRecord(
    fixture.materialization,
    `${label}.materialization`,
  );
  const allowedMaterializationKeys = [
    'bundleRoot',
    'manifestPath',
    'designRequestPath',
  ];
  if (Object.hasOwn(materialization, 'humanDecisionPath')) {
    allowedMaterializationKeys.push('humanDecisionPath');
  }
  requireExactKeys(
    materialization,
    allowedMaterializationKeys,
    `${label}.materialization`,
  );
  const relativeBundleRoot = recordString(
    materialization,
    'bundleRoot',
    `${label}.materialization`,
  );
  if (path.isAbsolute(relativeBundleRoot)) {
    throw new DesignflowProviderFixtureError(
      `${label}.materialization.bundleRoot must be relative to the configured base directory`,
    );
  }
  const bundleRootCandidate = path.resolve(baseDirectory, relativeBundleRoot);
  if (!isWithin(baseDirectory, bundleRootCandidate)) {
    throw new DesignflowProviderFixtureError(
      `${label}.materialization.bundleRoot escapes the configured base directory`,
    );
  }
  const bundleRoot = existingDirectory(
    bundleRootCandidate,
    `${label}.materialization.bundleRoot`,
  );
  if (!isWithin(baseDirectory, bundleRoot)) {
    throw new DesignflowProviderFixtureError(
      `${label}.materialization.bundleRoot resolves outside the configured base directory`,
    );
  }
  const humanDecisionPath = Object.hasOwn(materialization, 'humanDecisionPath')
    ? recordString(
      materialization,
      'humanDecisionPath',
      `${label}.materialization`,
    )
    : undefined;
  return {
    kind,
    requestId: recordString(fixture, 'requestId', label),
    requestDigest: recordString(fixture, 'requestDigest', label),
    materialization: {
      bundleRoot,
      manifestPath: recordString(
        materialization,
        'manifestPath',
        `${label}.materialization`,
      ),
      designRequestPath: recordString(
        materialization,
        'designRequestPath',
        `${label}.materialization`,
      ),
      humanDecisionPath,
    },
  };
}

function validateDesignRequestEnvelope(request: DesignflowDesignRequest): void {
  if (!isRecord(request)) {
    throw new TypeError('Design Request must be a JSON object');
  }
  if (request.schemaVersion !== '1.0') {
    throw new TypeError('Design Request schemaVersion must equal 1.0');
  }
  if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0) {
    throw new TypeError('Design Request requestId must be a non-empty string');
  }
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): asserts value is DesignflowJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} contains non-JSON value ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} contains a cycle`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} contains a non-plain object`);
    }
    for (const item of Object.values(value)) {
      assertJsonValue(item, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function materializedFileUri(
  bundleRoot: string,
  candidate: string,
  label: string,
): string {
  const root = existingDirectory(bundleRoot, 'Designflow bundle root');
  const file = existingFile(path.resolve(root, candidate), label);
  if (!isWithin(root, file)) {
    throw new DesignflowProviderInvalidResponseError(
      '<unknown>',
      `${label} resolves outside the bundle root`,
    );
  }
  return pathToFileURL(file).href;
}

function existingDirectory(candidate: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(candidate));
  } catch (error) {
    throw new DesignflowProviderFixtureError(
      `${label} does not exist: ${errorMessage(error)}`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new DesignflowProviderFixtureError(`${label} is not a directory`);
  }
  return resolved;
}

function existingFile(candidate: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(candidate));
  } catch (error) {
    throw new DesignflowProviderFixtureError(
      `${label} does not exist: ${errorMessage(error)}`,
    );
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new DesignflowProviderFixtureError(`${label} is not a file`);
  }
  return resolved;
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new DesignflowProviderFixtureError(
      `${label} is not valid JSON: ${errorMessage(error)}`,
    );
  }
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!isRecord(candidate)) {
    throw new DesignflowProviderFixtureError(`${label} must be an object`);
  }
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function recordString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
    throw new DesignflowProviderFixtureError(
      `${label}.${key} must be a non-empty string`,
    );
  }
  return record[key];
}

function requireNonEmptyString(candidate: string, label: string): string {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new DesignflowProviderFixtureError(`${label} must be a non-empty string`);
  }
  return candidate;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new DesignflowProviderFixtureError(
      `${label} fields must be exactly ${wanted.join(', ')}; got ${actual.join(', ')}`,
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
