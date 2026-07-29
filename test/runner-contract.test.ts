import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  EnqueueJobInput,
  RunnerJobFailureV1Contract,
  RunnerJobPayloadV1Contract,
  RunnerJobResultV1Contract,
} from '../src/control-store/types.js';
import { RunnerExecutionError } from '../src/runner/errors.js';

function fixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.join(
      process.cwd(),
      'contracts/control-store/v1/fixtures/runner-job.valid.json',
    ),
    'utf8',
  )) as Record<string, unknown>;
}

function ajv(): Ajv2020 {
  const validator = new Ajv2020({ strict: true });
  validator.addFormat(
    'uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  validator.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
  return validator;
}

describe('isolated runner published contracts', () => {
  it('accepts the exact versioned payload in TypeScript and JSON Schema', () => {
    const payload = fixture();
    expect(RunnerJobPayloadV1Contract.parse(payload)).toEqual(payload);
    const schema = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'contracts/control-store/v1/runner-job.schema.json',
      ),
      'utf8',
    ));
    const validate = ajv().compile(schema);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps JSON Schema and TypeScript required fields and event-mode rules identical', () => {
    const payload = fixture();
    const schema = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'contracts/control-store/v1/runner-job.schema.json',
      ),
      'utf8',
    ));
    const validate = ajv().compile(schema);
    const execution = payload.execution as Record<string, unknown>;
    const cases = [
      { ...payload, artifacts: undefined },
      {
        ...payload,
        execution: { ...execution, requiredChecks: undefined },
      },
      {
        ...payload,
        execution: { ...execution, mergeMethod: undefined },
      },
      {
        ...payload,
        execution: { ...execution, readyLabel: undefined },
      },
      {
        ...payload,
        execution: { ...execution, claimedLabel: undefined },
      },
      {
        ...payload,
        execution: { ...execution, mode: 'pr_reconciliation' },
      },
      {
        ...payload,
        event: {
          kind: 'pull_request',
          number: 38,
          action: 'synchronize',
        },
        execution: { ...execution, mode: 'development_turn' },
      },
    ].map((candidate) => JSON.parse(JSON.stringify(candidate)));
    for (const invalid of cases) {
      expect(validate(invalid), JSON.stringify(validate.errors)).toBe(false);
      expect(() => RunnerJobPayloadV1Contract.parse(invalid)).toThrow();
    }
  });

  it('keeps whitespace and UTC timestamp semantics identical across validators', () => {
    const payload = fixture();
    const schema = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'contracts/control-store/v1/runner-job.schema.json',
      ),
      'utf8',
    ));
    const validate = ajv().compile(schema);
    const execution = payload.execution as Record<string, unknown>;
    const artifact = (payload.artifacts as Record<string, unknown>[])[0]!;
    const invalid = [
      {
        ...payload,
        execution: { ...execution, requiredChecks: ['   '] },
      },
      {
        ...payload,
        execution: { ...execution, requiredChecks: [' test'] },
      },
      {
        ...payload,
        event: {
          kind: 'repository',
          trigger: 'push',
          identity: ' ',
        },
        execution: { ...execution, mode: 'pr_reconciliation' },
      },
      {
        ...payload,
        artifacts: [{
          ...artifact,
          createdAt: '2026-07-25T09:00:00+09:00',
        }],
      },
    ];
    for (const candidate of invalid) {
      expect(validate(candidate), JSON.stringify(validate.errors)).toBe(false);
      expect(() => RunnerJobPayloadV1Contract.parse(candidate)).toThrow();
    }
  });

  it('rejects unknown versions, arbitrary commands, host paths, clone URLs, and unsafe refs', () => {
    const payload = fixture();
    for (const invalid of [
      { ...payload, schemaVersion: 2 },
      { ...payload, command: 'rm -rf /' },
      { ...payload, hostPath: '/Users/operator/repository' },
      { ...payload, cloneUrl: 'ssh://attacker/repository' },
      {
        ...payload,
        repository: { owner: 'MrBaron3', name: 'workflow' },
      },
      {
        ...payload,
        target: { baseRef: 'main; curl attacker.invalid' },
      },
      {
        ...payload,
        execution: {
          ...(payload.execution as Record<string, unknown>),
          readyLabel: 'ready\nmalicious',
        },
      },
      {
        ...payload,
        artifacts: [{
          uri:
            'volume://registrations/ca3126a8-b83f-4698-90af-462523880c20/jobs/../secret',
          sha256: 'a'.repeat(64),
          sizeBytes: 1,
          createdAt: '2026-07-25T00:00:00.000Z',
        }],
      },
    ]) {
      expect(() => RunnerJobPayloadV1Contract.parse(invalid)).toThrow();
    }
  });

  it('makes the control-store enqueue seam validate agentops.runner payloads', () => {
    const base = {
      registrationId: 'ca3126a8-b83f-4698-90af-462523880c20',
      registrationVersion: 1,
      source: { kind: 'manual' as const, key: 'runner-job-1' },
      idempotencyKey: 'runner-job-1',
      jobType: 'agentops.runner',
      payload: fixture(),
    };
    expect(EnqueueJobInput.parse(base).jobType).toBe('agentops.runner');
    expect(() => EnqueueJobInput.parse({
      ...base,
      payload: { ...fixture(), schemaVersion: 99 },
    })).toThrow(/schemaVersion|Invalid literal/);
  });

  it('publishes strict typed result and failure contracts', () => {
    const artifact = {
      uri: 'volume://registrations/ca3126a8-b83f-4698-90af-462523880c20/jobs/one/result.json',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    expect(RunnerJobResultV1Contract.parse({
      schemaVersion: 1,
      status: 'succeeded',
      jobId: 'db837db2-30d7-4788-a56f-00056f5d550e',
      attemptNumber: 1,
      repository: 'mrbaron3/workflow',
      headSha: 'b'.repeat(40),
      pullRequestNumber: 38,
      artifacts: [artifact],
      completedAt: '2026-07-25T00:01:00.000Z',
    }).artifacts).toEqual([artifact]);
    expect(RunnerJobFailureV1Contract.parse({
      schemaVersion: 1,
      status: 'failed',
      code: 'lease_lost',
      message: 'lease expired',
      retryable: false,
      boundary: 'push',
      observedAt: '2026-07-25T00:01:00.000Z',
    }).code).toBe('lease_lost');
  });

  it('normalizes provider diagnostics before persisting a strict failure', () => {
    const failure = new RunnerExecutionError(
      'provider_failure',
      '\n provider exited with status 1 \n',
      true,
      'provider',
    ).toFailure(new Date('2026-07-25T00:01:00.000Z'));
    expect(failure.message).toBe('provider exited with status 1');
    expect(() => RunnerJobFailureV1Contract.parse(failure)).not.toThrow();
  });

  it('keeps result/failure UTC and nonblank semantics aligned with JSON Schema', () => {
    const jobSchema = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'contracts/control-store/v1/runner-job.schema.json',
    ), 'utf8'));
    const resultSchema = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'contracts/control-store/v1/runner-result.schema.json',
    ), 'utf8'));
    const failureSchema = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'contracts/control-store/v1/runner-failure.schema.json',
    ), 'utf8'));
    const validator = ajv();
    validator.addSchema(jobSchema);
    const validateResult = validator.compile(resultSchema);
    const validateFailure = validator.compile(failureSchema);
    const invalidResult = {
      schemaVersion: 1,
      status: 'succeeded',
      jobId: 'db837db2-30d7-4788-a56f-00056f5d550e',
      attemptNumber: 1,
      repository: 'mrbaron3/workflow',
      headSha: null,
      pullRequestNumber: null,
      artifacts: [],
      completedAt: '2026-07-25T09:00:00+09:00',
    };
    const invalidFailure = {
      schemaVersion: 1,
      status: 'failed',
      code: 'lease_lost',
      message: '   ',
      retryable: false,
      boundary: 'push',
      observedAt: '2026-07-25T09:00:00+09:00',
    };
    expect(validateResult(invalidResult)).toBe(false);
    expect(() => RunnerJobResultV1Contract.parse(invalidResult)).toThrow();
    expect(validateFailure(invalidFailure)).toBe(false);
    expect(() => RunnerJobFailureV1Contract.parse(invalidFailure)).toThrow();
  });
});
