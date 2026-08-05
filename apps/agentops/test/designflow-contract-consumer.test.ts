import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DESIGNFLOW_CONTRACT_PIN,
  DesignflowContractConsumer,
  digestDesignflowArtifact,
  digestDesignflowManifest,
  validatePinnedDesignflowFixture,
} from '../src/designflow/contract-consumer.js';
import { REPOSITORY_ROOT as MONOREPO_ROOT } from '../src/runtime/roots.js';

const REPOSITORY_ROOT = MONOREPO_ROOT;
const CONTRACT_RELATIVE_ROOT =
  'contracts/designflow/contract-v1.0.0-rc.1';
const PINNED_CONTRACT_ROOT = path.join(
  REPOSITORY_ROOT,
  CONTRACT_RELATIVE_ROOT,
);
const EXAMPLES = 'contracts/v1/examples';
const MANIFEST = `${EXAMPLES}/design-bundle-manifest.example.json`;
const DESIGN_REQUEST = `${EXAMPLES}/design-request.example.json`;
const DECISION = `${EXAMPLES}/human-design-decision.example.json`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('Designflow contract consumer', () => {
  it('accepts the normative pinned fixture and exposes reviewed lock provenance', () => {
    const result = validatePinnedDesignflowFixture(REPOSITORY_ROOT);

    expect(result).toEqual({
      providerRef: DESIGNFLOW_CONTRACT_PIN.providerRef,
      providerCommit: DESIGNFLOW_CONTRACT_PIN.commit,
      contractDigest: DESIGNFLOW_CONTRACT_PIN.contractDigest,
      bundleId: 'design-bundle-001',
      requestId: 'design-dashboard-001',
      revisionId: 'design-revision-001',
      sourceDigest:
        'sha256:53f50e60acdf44bc78fa0eac5c122b5a3c08214f2ca3974cdb33edb2e01165a9',
      bundleDigest:
        'sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97',
      artifactIds: [
        'capabilityRequirements',
        'designSystemDelta',
        'designTokens',
        'experience',
        'preview',
      ],
      capabilityIds: [
        'cap-list-registration-status',
        'cap-retry-delivery',
      ],
      decisionId: 'design-decision-001',
      decisionVerdict: 'approve',
      decisionSupersedesDecisionId: null,
    });
  });

  it('rejects schema-invalid content even when every digest is rebound', () => {
    const bundleRoot = copyPinnedBundle();
    rewriteJson(
      path.join(bundleRoot, EXAMPLES, 'experience-contract.example.json'),
      (value) => {
        value.unapprovedField = true;
      },
    );
    rebindBundle(bundleRoot, 'experience');

    expect(() => validateBundle(bundleRoot)).toThrow(
      /does not conform to urn:designflow:schema:v1:experience-contract/,
    );
  });

  it('rejects a dangling cross-document trace even when schema and digests remain valid', () => {
    const bundleRoot = copyPinnedBundle();
    rewriteJson(
      path.join(bundleRoot, EXAMPLES, 'capability-requirements.example.json'),
      (value) => {
        const capabilities = value.capabilities as Array<Record<string, unknown>>;
        capabilities[0]!.sourceRequirementIds = ['REQ-DASH-UNKNOWN'];
      },
    );
    rebindBundle(bundleRoot, 'capabilityRequirements');

    expect(() => validateBundle(bundleRoot)).toThrow(
      /capability cap-list-registration-status references unknown id REQ-DASH-UNKNOWN/,
    );
  });

  it('rejects artifact bytes that differ from their manifest digest', () => {
    const bundleRoot = copyPinnedBundle();
    fs.appendFileSync(
      path.join(bundleRoot, EXAMPLES, 'preview.html'),
      '\n<!-- digest mutation -->\n',
    );

    expect(() => validateBundle(bundleRoot)).toThrow(
      /bundle artifact preview digest mismatch/,
    );
  });

  it('rejects non-UTF-8 JSON instead of validating replacement characters', () => {
    const bundleRoot = copyPinnedBundle();
    fs.appendFileSync(
      path.join(bundleRoot, DESIGN_REQUEST),
      Buffer.from([0x80]),
    );

    expect(() => validateBundle(bundleRoot)).toThrow(
      /Design Request is not valid JSON/,
    );
  });

  it('rejects provenance, schema pin, and aggregate lock mutations before validation', () => {
    const provenanceRoot = copyPinnedRepositoryInputs();
    rewriteJson(
      path.join(provenanceRoot, CONTRACT_RELATIVE_ROOT, 'PROVENANCE.json'),
      (value) => {
        value.commit = '0'.repeat(40);
      },
    );
    expect(
      () => new DesignflowContractConsumer({ repositoryRoot: provenanceRoot }),
    ).toThrow(/contract provenance digest mismatch/);

    const schemaRoot = copyPinnedRepositoryInputs();
    fs.appendFileSync(
      path.join(
        schemaRoot,
        CONTRACT_RELATIVE_ROOT,
        'contracts/v1/common.schema.json',
      ),
      '\n',
    );
    expect(
      () => new DesignflowContractConsumer({ repositoryRoot: schemaRoot }),
    ).toThrow(/locked contract file contracts\/v1\/common\.schema\.json digest mismatch/);

    const lockRoot = copyPinnedRepositoryInputs();
    rewriteJson(
      path.join(lockRoot, CONTRACT_RELATIVE_ROOT, 'contract.lock.json'),
      (value) => {
        value.contractDigest = `sha256:${'0'.repeat(64)}`;
      },
    );
    expect(
      () => new DesignflowContractConsumer({ repositoryRoot: lockRoot }),
    ).toThrow(/contractDigest is not the reviewed RC\.1 pin/);
  });
});

function validateBundle(bundleRoot: string) {
  const consumer = new DesignflowContractConsumer({
    repositoryRoot: REPOSITORY_ROOT,
  });
  return consumer.validateBundle({
    bundleRoot,
    manifestPath: MANIFEST,
    designRequestPath: DESIGN_REQUEST,
    humanDecisionPath: DECISION,
  });
}

function copyPinnedBundle(): string {
  const destination = makeTemporaryDirectory('designflow-bundle-');
  fs.cpSync(PINNED_CONTRACT_ROOT, destination, { recursive: true });
  return destination;
}

function copyPinnedRepositoryInputs(): string {
  const destination = makeTemporaryDirectory('designflow-repository-');
  const contractDestination = path.join(destination, CONTRACT_RELATIVE_ROOT);
  fs.mkdirSync(path.dirname(contractDestination), { recursive: true });
  fs.cpSync(PINNED_CONTRACT_ROOT, contractDestination, { recursive: true });
  return destination;
}

function makeTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function rebindBundle(bundleRoot: string, artifactId: string): void {
  const manifestPath = path.join(bundleRoot, MANIFEST);
  const manifest = readJson(manifestPath);
  const artifacts = manifest.artifacts as Record<
    string,
    { path: string; digest: string; mediaType: string }
  >;
  const artifact = artifacts[artifactId]!;
  artifact.digest = digestDesignflowArtifact(
    fs.readFileSync(path.join(bundleRoot, artifact.path)),
    artifact.mediaType,
  );
  manifest.bundleDigest = digestDesignflowManifest(manifest);
  writeJson(manifestPath, manifest);

  rewriteJson(path.join(bundleRoot, DECISION), (decision) => {
    decision.bundleDigest = manifest.bundleDigest;
  });
}

function rewriteJson(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const value = readJson(filePath);
  mutate(value);
  writeJson(filePath, value);
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
