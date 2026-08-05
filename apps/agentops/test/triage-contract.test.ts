import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  EnqueueJobInput,
  TriageDecisionV1Contract,
  TriageJobPayloadV1Contract,
  TriageJobResultV1Contract,
} from '../src/control-store/types.js';

function fixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.join(
      process.cwd(),
      'contracts/control-store/v1/fixtures/triage-job.valid.json',
    ),
    'utf8',
  )) as Record<string, unknown>;
}

function validator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat(
    'uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  ajv.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
  ajv.addFormat('uri', (value: string) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
  return ajv;
}

describe('issue triage published contracts', () => {
  it('accepts the same strict job payload in TypeScript and JSON Schema', () => {
    const payload = fixture();
    expect(TriageJobPayloadV1Contract.parse(payload)).toEqual(payload);
    const schema = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'contracts/control-store/v1/triage-job.schema.json',
    ), 'utf8'));
    const validate = validator().compile(schema);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...payload, schemaVersion: 2 },
      { ...payload, command: 'gh issue edit' },
      {
        ...payload,
        repository: { owner: 'ExampleOrg', name: 'design-system' },
      },
      {
        ...payload,
        issue: { number: 0, observedUpdatedAt: 'not-a-date' },
      },
    ]) {
      expect(validate(invalid), JSON.stringify(validate.errors)).toBe(false);
      expect(() => TriageJobPayloadV1Contract.parse(invalid)).toThrow();
    }
  });

  it('validates agentops.triage at the enqueue boundary', () => {
    const base = {
      registrationId: 'ca3126a8-b83f-4698-90af-462523880c20',
      registrationVersion: 1,
      source: { kind: 'poll' as const, key: 'sample-issue-4' },
      idempotencyKey: 'sample-issue-4',
      jobType: 'agentops.triage',
      payload: fixture(),
    };
    expect(EnqueueJobInput.parse(base).jobType).toBe('agentops.triage');
    expect(() => EnqueueJobInput.parse({
      ...base,
      payload: { ...fixture(), schemaVersion: 99 },
    })).toThrow();
  });

  it('keeps provider decisions bounded and excludes labels or commands', () => {
    const decision = {
      schemaVersion: 1,
      type: 'feature',
      northStarAlignment: 'aligned',
      readiness: 'blocked',
      priority: 'p1',
      summary: 'AuthoringBackend is required before a real provider adapter.',
      rationale: ['The dependency is explicit in the roadmap.'],
      dependencies: [{
        repository: 'sample/design-system',
        issueNumber: 4,
        relationship: 'blocked_by',
      }],
      duplicateCandidates: [],
      missingInformation: [],
    };
    expect(TriageDecisionV1Contract.parse(decision)).toEqual(decision);
    const schema = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'contracts/control-store/v1/triage-decision.schema.json',
    ), 'utf8')) as Record<string, unknown>;
    const validate = validator().compile(schema);
    expect(validate(decision), JSON.stringify(validate.errors)).toBe(true);
    const visit = (value: unknown, location = '$'): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const node = value as Record<string, unknown>;
      if ('const' in node || 'enum' in node) {
        expect(node.type, `${location} must state its JSON type`).toEqual(
          expect.any(String),
        );
      }
      if (typeof node.pattern === 'string') {
        expect(
          node.pattern,
          `${location} must avoid response-schema lookaround`,
        ).not.toMatch(/\(\?(?:[=!]|<[=!])/);
      }
      for (const [key, child] of Object.entries(node)) {
        visit(child, `${location}.${key}`);
      }
    };
    visit(schema);
    for (const repository of ['sample/.', 'sample/..']) {
      const invalid = {
        ...decision,
        dependencies: [{
          repository,
          issueNumber: 4,
          relationship: 'blocked_by',
        }],
      };
      expect(validate(invalid), JSON.stringify(validate.errors)).toBe(false);
      expect(() => TriageDecisionV1Contract.parse(invalid)).toThrow();
    }
    for (const repository of ['sample/.a', 'sample/...']) {
      const valid = {
        ...decision,
        dependencies: [{
          repository,
          issueNumber: 4,
          relationship: 'blocked_by',
        }],
      };
      expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
      expect(TriageDecisionV1Contract.parse(valid)).toEqual(valid);
    }
    expect(() => TriageDecisionV1Contract.parse({
      ...decision,
      labels: ['ready'],
    })).toThrow();
    expect(() => TriageDecisionV1Contract.parse({
      ...decision,
      command: 'merge',
    })).toThrow();
  });

  it('publishes a strict durable result contract', () => {
    expect(TriageJobResultV1Contract.parse({
      schemaVersion: 1,
      status: 'succeeded',
      jobId: 'db837db2-30d7-4788-a56f-00056f5d550e',
      attemptNumber: 1,
      repository: 'sample/design-system',
      issueNumber: 4,
      outcome: 'promoted',
      sourceDigest: null,
      decision: null,
      commentUrl: null,
      appliedLabels: [],
      promotedJobId: 'e8b37db2-30d7-4788-a56f-00056f5d550e',
      completedAt: '2026-07-29T00:01:00.000Z',
    }).outcome).toBe('promoted');
  });
});
