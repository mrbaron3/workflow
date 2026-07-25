import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  CONTROL_SCHEMA_VERSION,
  ControlSchemaError,
  ControlStoreUnavailableError,
} from './types.js';

const MIGRATION_LOCK_KEY = 0x4349534f02;

export interface SchemaMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export function controlMigrationDirectory(root: string = process.cwd()): string {
  return path.join(root, 'db', 'control-store', 'migrations');
}

export function loadControlMigrations(root?: string): SchemaMigration[] {
  const directory = controlMigrationDirectory(root);
  let names: string[];
  try {
    names = fs.readdirSync(directory)
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
  } catch (error) {
    throw new ControlSchemaError(
      `control-store migration directory is unavailable: ${directory}: ${String(error)}`,
    );
  }
  const migrations = names.map((name) => {
    const version = Number(name.slice(0, 4));
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    return {
      version,
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  if (
    migrations.length !== CONTROL_SCHEMA_VERSION
    || migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    throw new ControlSchemaError(
      `migration set must be contiguous through version ${CONTROL_SCHEMA_VERSION}`,
    );
  }
  return migrations;
}

async function schemaObjects(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'agentops_control'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.name);
}

async function hasMigrationTable(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('agentops_control.schema_migrations') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

async function validateInstalled(
  client: PoolClient,
  migrations: readonly SchemaMigration[],
): Promise<number> {
  const result = await client.query<{ version: number; name: string; checksum: string }>(
    `SELECT version, name, checksum
       FROM agentops_control.schema_migrations
      ORDER BY version`,
  );
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]!;
    const expected = migrations[index];
    if (!expected || row.version !== expected.version) {
      throw new ControlSchemaError(
        `unknown or non-contiguous control schema version ${row.version}`,
      );
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new ControlSchemaError(
        `control schema migration ${row.version} checksum/name mismatch`,
      );
    }
  }
  return result.rows.at(-1)?.version ?? 0;
}

function asUnavailable(error: unknown): Error {
  if (error instanceof ControlSchemaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ControlStoreUnavailableError(`control store failed closed: ${message}`);
}

/** Apply every pending version in one transaction. Failed/partial DDL is rolled back. */
export async function migrateControlSchema(
  pool: Pool,
  options: { root?: string } = {},
): Promise<number> {
  const migrations = loadControlMigrations(options.root);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    const trackingPresent = await hasMigrationTable(client);
    const objects = await schemaObjects(client);
    if (!trackingPresent && objects.length > 0) {
      throw new ControlSchemaError(
        `partial control schema exists without migration history: ${objects.join(', ')}`,
      );
    }
    if (!trackingPresent) {
      await client.query('CREATE SCHEMA IF NOT EXISTS agentops_control');
      await client.query(`
        CREATE TABLE agentops_control.schema_migrations (
          version integer PRIMARY KEY CHECK (version > 0),
          name text NOT NULL UNIQUE,
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
    }
    const installed = await validateInstalled(client, migrations);
    for (const migration of migrations.filter((item) => item.version > installed)) {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO agentops_control.schema_migrations(version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
    }
    const finalVersion = await validateInstalled(client, migrations);
    if (finalVersion !== CONTROL_SCHEMA_VERSION) {
      throw new ControlSchemaError(
        `control schema version ${finalVersion} is not supported version ${CONTROL_SCHEMA_VERSION}`,
      );
    }
    await client.query('COMMIT');
    return finalVersion;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure; a broken connection is already fail-closed.
      }
    }
    throw asUnavailable(error);
  } finally {
    client?.release();
  }
}

/** Verify exact known schema without mutating anything; consumers call this before startup. */
export async function assertControlSchema(
  pool: Pool,
  options: { root?: string } = {},
): Promise<void> {
  const migrations = loadControlMigrations(options.root);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    if (!(await hasMigrationTable(client))) {
      const objects = await schemaObjects(client);
      throw new ControlSchemaError(
        objects.length > 0
          ? `partial control schema exists without migration history: ${objects.join(', ')}`
          : 'control schema is not installed',
      );
    }
    const installed = await validateInstalled(client, migrations);
    if (installed !== CONTROL_SCHEMA_VERSION) {
      throw new ControlSchemaError(
        `control schema version ${installed} is not supported version ${CONTROL_SCHEMA_VERSION}`,
      );
    }
  } catch (error) {
    throw asUnavailable(error);
  } finally {
    client?.release();
  }
}
