import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_SCHEMA_VERSION,
  JobEnvelopeContract,
  loadControlMigrations,
} from '../src/control-store/index.js';

describe('language-neutral control-store contract', () => {
  it('publishes a contiguous checksummed migration set', () => {
    const migrations = loadControlMigrations();
    expect(migrations.map(({ version }) => version)).toEqual([CONTROL_SCHEMA_VERSION]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.sql).toContain('jobs_one_active_per_repository');
    expect(migrations[0]?.sql).toContain('pg_notify');
    expect(fs.readFileSync(
      path.join(process.cwd(), 'src', 'control-store', 'store.ts'),
      'utf8',
    )).toContain('FOR UPDATE OF j, r SKIP LOCKED');
  });

  it('keeps the v1 JSON fixture compatible with the TypeScript contract', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'contracts',
        'control-store',
        'v1',
        'fixtures',
        'job-envelope.valid.json',
      ),
      'utf8',
    ));
    const schema = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'contracts',
        'control-store',
        'v1',
        'job-envelope.schema.json',
      ),
      'utf8',
    ));
    const ajv = new Ajv2020({ strict: true });
    ajv.addFormat(
      'uuid',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    ajv.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
    const validate = ajv.compile(schema);
    expect(validate(fixture), validate.errors?.map((error) => error.message).join(', '))
      .toBe(true);
    expect(JobEnvelopeContract.parse(fixture)).toEqual(fixture);
    expect(fixture.status).toBe('queued');
    const unexpected = { ...fixture, unexpected: true };
    expect(validate(unexpected)).toBe(false);
    expect(() => JobEnvelopeContract.parse(unexpected)).toThrow();
    expect(validate({ ...fixture, status: 'unknown' })).toBe(false);
  });

  it('stores only artifact metadata in the schema', () => {
    const sql = loadControlMigrations()[0]!.sql;
    expect(sql).toContain('uri text NOT NULL');
    expect(sql).toContain('sha256 text NOT NULL');
    expect(sql).toContain('size_bytes bigint NOT NULL');
    expect(sql).not.toMatch(/\bartifact_(?:body|content|bytes|data)\b/);
  });

  it('has no JSON-file fallback in the PostgreSQL control-store implementation', () => {
    const directory = path.join(process.cwd(), 'src', 'control-store');
    const source = fs.readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && name !== 'migrations.ts')
      .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('\n');
    expect(source).not.toContain('webhooks.json');
    expect(source).not.toContain("from 'node:fs'");
    const productionSource = fs.readdirSync(path.join(process.cwd(), 'src'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.readFileSync(path.join(process.cwd(), 'src', name), 'utf8'))
      .join('\n');
    expect(productionSource).not.toContain(['webhooks', 'json'].join('.'));
  });
});
