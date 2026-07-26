import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('CISO-07 integrated release source contracts', () => {
  it('builds all three release roles from immutable standard-OCI bases', () => {
    const containerfile = read('deploy/Containerfile');
    const externalFromLines = containerfile
      .split('\n')
      .filter((line) => line.startsWith('FROM ') && line.includes(':'));
    expect(externalFromLines).toHaveLength(5);
    for (const line of externalFromLines) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}\s+AS\s+[a-z0-9-]+$/);
    }
    expect(containerfile).toContain(' AS control');
    expect(containerfile).toContain(' AS runner');
    expect(containerfile).toContain(' AS postgres');
    expect(containerfile).toContain('git=1:2.39.5-0+deb12u3');
    expect(containerfile).toContain(
      'snapshot.debian.org/archive/debian/20260714T000000Z',
    );
    expect(containerfile).toContain(
      'snapshot.debian.org/archive/debian-security/20260714T000000Z',
    );
    expect(containerfile).toContain(
      'deploy/provider-cli/package-lock.json',
    );
    expect(containerfile).toContain(
      'npm ci --omit=dev --ignore-scripts --prefix /opt/provider-cli',
    );
    expect(containerfile).toContain('golang:1.26.5-bookworm@sha256:');
    expect(containerfile).toContain(
      'gcr.io/distroless/static-debian12:nonroot@sha256:',
    );
    expect(containerfile).toContain('github.com/cli/cli/v2/cmd/gh');
    expect(read('deploy/gh/go.mod')).toContain(
      'google.golang.org/grpc v1.82.1',
    );
    const providerLock = JSON.parse(
      read('deploy/provider-cli/package-lock.json'),
    ) as {
      packages: Record<string, {
        version?: string;
        integrity?: string;
      }>;
    };
    expect(providerLock.packages['node_modules/@openai/codex']).toEqual(
      expect.objectContaining({
        version: '0.145.0',
        integrity: expect.stringMatching(/^sha512-/),
      }),
    );
    expect(providerLock.packages['node_modules/@anthropic-ai/claude-code'])
      .toEqual(expect.objectContaining({
        version: '2.1.220',
        integrity: expect.stringMatching(/^sha512-/),
      }));

    const manager = read('cmd/agentopsctl/manager.go');
    for (const target of ['postgres', 'control', 'runner']) {
      expect(manager).toMatch(new RegExp(`BuildImage\\([\\s\\S]*?"${target}"`));
    }
  });

  it('keeps Codex login and runtime mounts inside named credential boundaries', () => {
    const config = read('cmd/agentopsctl/config.go');
    const manager = read('cmd/agentopsctl/manager.go');
    const runtime = read('internal/lifecycle/runtime.go');
    expect(config).toContain('validateCodexAuthSource');
    expect(manager).toContain('CredentialVolume');
    expect(manager).toContain('Target:   "/run/agentops-credentials"');
    expect(manager).toContain('ReadOnly: true');
    expect(runtime).toContain('"exec", "--interactive", "--user", "65532:65532", name');
    expect(runtime).toContain('command.Stdin = stdin');
    expect(runtime).not.toContain('"copy", source');
    for (const forbidden of [
      'SSH_AUTH_SOCK',
      'docker.sock',
      'container.sock',
      ':/Users/',
      ':/home/',
    ]) {
      expect(manager).not.toContain(forbidden);
    }
  });

  it('preserves failed planning provenance and bounds the pre-main cutover', () => {
    const planning = JSON.parse(
      read('evidence/ciso-07/planning-resolution.json'),
    ) as {
      planningEnrichment: {
        status: string;
        preservedWithoutSuccessRewrite: boolean;
      };
      resolvedDecisions: unknown[];
      bootstrapCutover: { normalExecutionClaimsExcluded: string[] };
    };
    expect(planning.planningEnrichment).toEqual(expect.objectContaining({
      status: 'needs-human-review',
      preservedWithoutSuccessRewrite: true,
    }));
    expect(planning.resolvedDecisions).toHaveLength(7);
    expect(planning.bootstrapCutover.normalExecutionClaimsExcluded)
      .toHaveLength(3);
  });

  it('publishes a fail-closed complete-release evidence schema', () => {
    const schema = JSON.parse(
      read('contracts/ciso-07-release-evidence.schema.json'),
    ) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining([
      'source',
      'images',
      'topology',
      'registration',
      'monitoring',
      'execution',
      'recovery',
      'formalReviews',
      'github',
      'artifacts',
    ]));
    expect(schema.properties.result).toEqual({ const: 'passed' });
    expect(read('src/evidence/ciso07.ts')).toContain(
      'ciso07SemanticErrors',
    );

    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate({
      schemaVersion: '1.0',
      issue: 'mrbaron3/workflow#17',
      source: {
        immutableBase: '257dc557753b099a646c94d3e3cc700468ffb32a',
        initialHead: '0'.repeat(40),
        finalHead: '1'.repeat(40),
        treeSha256: '2'.repeat(64),
        pullRequest: 41,
        capturedAt: '2026-07-26T00:00:00Z',
      },
      result: 'passed',
    })).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'required' }),
    ]));
  });
});
