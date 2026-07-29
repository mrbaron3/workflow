import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DesignflowContractConsumer,
  digestDesignflowArtifact,
  digestDesignflowManifest,
} from '../src/designflow/contract-consumer.js';
import {
  DesignflowProviderFixtureError,
  DesignflowProviderInvalidResponseError,
  DesignflowProviderUnavailableError,
  FileDesignflowProvider,
  InMemoryDesignflowProvider,
  digestDesignflowRequest,
  type DesignflowDesignRequest,
  type DesignflowProvider,
  type DesignflowProviderFixture,
} from '../src/designflow/provider.js';

const REPOSITORY_ROOT = process.cwd();
const PINNED_CONTRACT_ROOT = path.join(
  REPOSITORY_ROOT,
  'contracts',
  'designflow',
  'contract-v1.0.0-rc.1',
);
const EXAMPLES = 'contracts/v1/examples';
const MANIFEST = `${EXAMPLES}/design-bundle-manifest.example.json`;
const DESIGN_REQUEST = `${EXAMPLES}/design-request.example.json`;
const DECISION = `${EXAMPLES}/human-design-decision.example.json`;
const PREVIEW = `${EXAMPLES}/preview.html`;

const consumer = new DesignflowContractConsumer({
  repositoryRoot: REPOSITORY_ROOT,
});
const temporaryDirectories: string[] = [];

type AdapterKind = 'in-memory' | 'file';

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe.each<AdapterKind>(['in-memory', 'file'])(
  '%s Designflow provider adapter',
  (adapterKind) => {
    it('returns only validated Bundle and Decision references for a successful fixture', async () => {
      const scenario = createScenario();
      const provider = createProvider(
        adapterKind,
        availableFixture(scenario),
        scenario.root,
      );

      const output = await provider.provide(scenario.request);

      expect(Object.keys(output).sort()).toEqual(['bundle', 'decision']);
      expect(output.bundle).toEqual({
        uri: realFileUri(path.join(scenario.bundleRoot, MANIFEST)),
        bundleId: 'design-bundle-001',
        requestId: 'design-dashboard-001',
        revisionId: 'design-revision-001',
        bundleDigest:
          'sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97',
      });
      expect(output.decision).toEqual({
        uri: realFileUri(path.join(scenario.bundleRoot, DECISION)),
        decisionId: 'design-decision-001',
        requestId: 'design-dashboard-001',
        revisionId: 'design-revision-001',
        bundleDigest:
          'sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97',
      });
      expect(Object.keys(output.bundle).sort()).toEqual([
        'bundleDigest',
        'bundleId',
        'requestId',
        'revisionId',
        'uri',
      ]);
      expect(Object.keys(output.decision!).sort()).toEqual([
        'bundleDigest',
        'decisionId',
        'requestId',
        'revisionId',
        'uri',
      ]);
      expect(Object.isFrozen(output)).toBe(true);
      expect(Object.isFrozen(output.bundle)).toBe(true);
      expect(Object.isFrozen(output.decision)).toBe(true);
    });

    it('passes through a valid ambiguous/request-changes fixture as references', async () => {
      const scenario = createScenario();
      makeAmbiguousRequestChangesBundle(scenario.bundleRoot);
      const provider = createProvider(
        adapterKind,
        availableFixture(scenario),
        scenario.root,
      );

      const output = await provider.provide(scenario.request);

      expect(output).not.toHaveProperty('status');
      expect(output).not.toHaveProperty('ambiguities');
      expect(output.decision).not.toBeNull();
      const decision = readJson(fileURLToPath(output.decision!.uri));
      expect(decision.verdict).toBe('request-changes');
      const experience = readJson(path.join(
        scenario.bundleRoot,
        EXAMPLES,
        'experience-contract.example.json',
      ));
      expect(experience.ambiguities).toEqual([
        'Operator retry confirmation remains unresolved',
      ]);
    });

    it('rejects an invalid fixture through the WF-DF-001 consumer', async () => {
      const scenario = createScenario();
      fs.appendFileSync(
        path.join(scenario.bundleRoot, PREVIEW),
        '\n<!-- invalid provider fixture -->\n',
      );
      const provider = createProvider(
        adapterKind,
        availableFixture(scenario),
        scenario.root,
      );

      await expect(provider.provide(scenario.request)).rejects.toThrow(
        DesignflowProviderInvalidResponseError,
      );
      await expect(provider.provide(scenario.request)).rejects.toThrow(
        /bundle artifact preview digest mismatch/,
      );
    });

    it('reproduces provider unavailability without any process or network', async () => {
      const scenario = createScenario();
      const fixture: DesignflowProviderFixture = {
        kind: 'unavailable',
        requestId: scenario.request.requestId,
        requestDigest: digestDesignflowRequest(scenario.request),
        message: 'fixture provider intentionally unavailable',
      };
      const provider = createProvider(adapterKind, fixture, scenario.root);

      await expect(provider.provide(scenario.request)).rejects.toThrow(
        DesignflowProviderUnavailableError,
      );
      await expect(provider.provide(scenario.request)).rejects.toThrow(
        /fixture provider intentionally unavailable/,
      );
    });
  },
);

describe('Designflow provider boundary', () => {
  it('binds the response sourceDigest to the complete Design Request input', async () => {
    const scenario = createScenario();
    const alteredRequest = structuredClone(scenario.request);
    const productIntent = alteredRequest.productIntent as Record<string, string>;
    productIntent.primaryOutcome = 'Semantically different request content';
    const fixture: DesignflowProviderFixture = {
      ...availableFixture(scenario),
      requestDigest: digestDesignflowRequest(alteredRequest),
    };
    const provider = new InMemoryDesignflowProvider({
      consumer,
      fixtures: [fixture],
    });

    await expect(provider.provide(alteredRequest)).rejects.toThrow(
      DesignflowProviderInvalidResponseError,
    );
    await expect(provider.provide(alteredRequest)).rejects.toThrow(
      /does not match input/,
    );
  });

  it('rejects CLI/runtime-shaped fields in the file fixture catalog', () => {
    const scenario = createScenario();
    const fixture = toFileFixture(availableFixture(scenario), scenario.root);
    const catalogPath = path.join(scenario.root, 'provider-fixtures.json');
    writeJson(catalogPath, {
      schemaVersion: '1.0',
      fixtures: [{
        ...fixture,
        command: ['designflow', 'generate'],
      }],
    });

    expect(() => new FileDesignflowProvider({
      consumer,
      fixturePath: catalogPath,
      baseDirectory: scenario.root,
    })).toThrow(DesignflowProviderFixtureError);
    expect(() => new FileDesignflowProvider({
      consumer,
      fixturePath: catalogPath,
      baseDirectory: scenario.root,
    })).toThrow(/fields must be exactly/);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a file fixture bundleRoot symlink that resolves outside its base directory',
    () => {
      const scenario = createScenario();
      const externalRoot = makeTemporaryDirectory('designflow-provider-external-');
      const externalBundle = path.join(externalRoot, 'bundle');
      fs.cpSync(PINNED_CONTRACT_ROOT, externalBundle, { recursive: true });
      fs.symlinkSync(externalBundle, path.join(scenario.root, 'escaped-bundle'), 'dir');
      const catalogPath = path.join(scenario.root, 'provider-fixtures.json');
      writeJson(catalogPath, {
        schemaVersion: '1.0',
        fixtures: [{
          kind: 'available',
          requestId: scenario.request.requestId,
          requestDigest: digestDesignflowRequest(scenario.request),
          materialization: {
            bundleRoot: 'escaped-bundle',
            manifestPath: MANIFEST,
            designRequestPath: DESIGN_REQUEST,
            humanDecisionPath: DECISION,
          },
        }],
      });

      expect(() => new FileDesignflowProvider({
        consumer,
        fixturePath: catalogPath,
        baseDirectory: scenario.root,
      })).toThrow(/resolves outside the configured base directory/);
    },
  );
});

interface Scenario {
  root: string;
  bundleRoot: string;
  request: DesignflowDesignRequest;
}

function createScenario(): Scenario {
  const root = makeTemporaryDirectory('designflow-provider-');
  const bundleRoot = path.join(root, 'bundle');
  fs.cpSync(PINNED_CONTRACT_ROOT, bundleRoot, { recursive: true });
  return {
    root,
    bundleRoot,
    request: readJson(path.join(bundleRoot, DESIGN_REQUEST)) as DesignflowDesignRequest,
  };
}

function availableFixture(scenario: Scenario): DesignflowProviderFixture {
  return {
    kind: 'available',
    requestId: scenario.request.requestId,
    requestDigest: digestDesignflowRequest(scenario.request),
    materialization: {
      bundleRoot: scenario.bundleRoot,
      manifestPath: MANIFEST,
      designRequestPath: DESIGN_REQUEST,
      humanDecisionPath: DECISION,
    },
  };
}

function createProvider(
  kind: AdapterKind,
  fixture: DesignflowProviderFixture,
  baseDirectory: string,
): DesignflowProvider {
  if (kind === 'in-memory') {
    return new InMemoryDesignflowProvider({
      consumer,
      fixtures: [fixture],
    });
  }
  const fixturePath = path.join(baseDirectory, 'provider-fixtures.json');
  writeJson(fixturePath, {
    schemaVersion: '1.0',
    fixtures: [toFileFixture(fixture, baseDirectory)],
  });
  return new FileDesignflowProvider({
    consumer,
    fixturePath,
    baseDirectory,
  });
}

function toFileFixture(
  fixture: DesignflowProviderFixture,
  baseDirectory: string,
): Record<string, unknown> {
  if (fixture.kind === 'unavailable') return { ...fixture };
  return {
    kind: fixture.kind,
    requestId: fixture.requestId,
    requestDigest: fixture.requestDigest,
    materialization: {
      bundleRoot: path.relative(
        baseDirectory,
        fixture.materialization.bundleRoot,
      ),
      manifestPath: fixture.materialization.manifestPath,
      designRequestPath: fixture.materialization.designRequestPath,
      humanDecisionPath: fixture.materialization.humanDecisionPath,
    },
  };
}

function makeAmbiguousRequestChangesBundle(bundleRoot: string): void {
  rewriteJson(
    path.join(bundleRoot, EXAMPLES, 'experience-contract.example.json'),
    (experience) => {
      experience.ambiguities = [
        'Operator retry confirmation remains unresolved',
      ];
    },
  );
  rebindBundleArtifact(bundleRoot, 'experience');
  rewriteJson(path.join(bundleRoot, DECISION), (decision) => {
    decision.verdict = 'request-changes';
    decision.rationale =
      'Retry confirmation remains ambiguous and requires another revision';
  });
}

function rebindBundleArtifact(bundleRoot: string, artifactId: string): void {
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

function makeTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function rewriteJson(
  filePath: string,
  mutate: (value: Record<string, any>) => void,
): void {
  const value = readJson(filePath);
  mutate(value);
  writeJson(filePath, value);
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function realFileUri(filePath: string): string {
  return pathToFileURL(fs.realpathSync(filePath)).href;
}
