import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const load = (name: string): object => JSON.parse(fs.readFileSync(
  path.join(root, 'contracts', 'github-credential', 'v1', name),
  'utf8',
)) as object;

describe('GitHub credential broker v1 contracts', () => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    formats: { 'date-time': true },
  });

  it('accepts only an exact versioned role request', () => {
    const validate = ajv.compile(load('token-request.schema.json'));
    expect(validate({ schemaVersion: 1, role: 'triage' })).toBe(true);
    expect(validate({
      schemaVersion: 1,
      role: 'triage',
      repositories: ['acme/widgets'],
    })).toBe(false);
    expect(validate({ schemaVersion: 2, role: 'runner' })).toBe(false);
  });

  it('bounds the secret response and rejects scope extensions', () => {
    const validate = ajv.compile(load('token-response.schema.json'));
    const response = {
      schemaVersion: 1,
      role: 'runner',
      token: 'x'.repeat(40),
      expiresAt: '2026-07-29T12:00:00Z',
      repositories: ['acme/widgets'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
      actorLogin: 'agentops-test[bot]',
    };
    expect(validate(response)).toBe(true);
    expect(validate({
      ...response,
      permissions: { administration: 'admin' },
    })).toBe(false);
    expect(validate({
      ...response,
      repositories: ['Acme/widgets'],
    })).toBe(false);
    expect(validate({ ...response, privateKey: 'forbidden' })).toBe(false);
  });
});
