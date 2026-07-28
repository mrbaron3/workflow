import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ArtifactReference,
  Lease,
} from '../control-store/types.js';
import type { PostgresControlStore } from '../control-store/store.js';
import { RunnerExecutionError } from './errors.js';
import {
  artifactUri,
  registrationWorkspacePath,
  resolveArtifactUri,
  type PreparedRunnerWorkspace,
} from './workspace.js';

function assertRealPathInside(root: string, candidate: string): void {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedCandidate = fs.realpathSync(candidate);
  if (
    resolvedCandidate !== resolvedRoot
    && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `artifact resolves outside the Registration workspace: ${candidate}`,
      false,
    );
  }
}

export function digestFile(
  file: string,
  registrationRoot?: string,
): { sha256: string; sizeBytes: number } {
  if (registrationRoot) assertRealPathInside(registrationRoot, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `artifact is not a regular file: ${file}`,
      false,
    );
  }
  const bytes = fs.readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

export function verifyArtifactReferences(
  workspaceRoot: string,
  registrationId: string,
  references: readonly ArtifactReference[],
): void {
  const prefix = `volume://registrations/${registrationId}/`;
  for (const reference of references) {
    if (!reference.uri.startsWith(prefix)) {
      throw new RunnerExecutionError(
        'artifact_integrity',
        `artifact belongs to another Registration: ${reference.uri}`,
        false,
      );
    }
    const file = resolveArtifactUri(workspaceRoot, reference);
    const registrationRoot = registrationWorkspacePath(
      workspaceRoot,
      registrationId,
    );
    let actual: { sha256: string; sizeBytes: number };
    try {
      actual = digestFile(file, registrationRoot);
    } catch (error) {
      if (error instanceof RunnerExecutionError) throw error;
      throw new RunnerExecutionError(
        'artifact_integrity',
        `artifact is unavailable: ${reference.uri}`,
        false,
        null,
        { cause: error },
      );
    }
    if (actual.sha256 !== reference.sha256 || actual.sizeBytes !== reference.sizeBytes) {
      throw new RunnerExecutionError(
        'artifact_integrity',
        `artifact digest/size mismatch: ${reference.uri}`,
        false,
      );
    }
  }
}

export async function persistJsonArtifact(input: {
  store: PostgresControlStore;
  lease: Lease;
  workerId: string;
  workspace: PreparedRunnerWorkspace;
  kind: string;
  name: string;
  value: unknown;
}): Promise<ArtifactReference> {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(input.name)) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `artifact file name is invalid: ${input.name}`,
      false,
    );
  }
  const finalPath = path.join(input.workspace.artifactPath, input.name);
  const temporary = `${finalPath}.${randomUUID()}.tmp`;
  assertRealPathInside(
    input.workspace.registrationRoot,
    input.workspace.artifactPath,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(input.value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, finalPath);
  const digest = digestFile(finalPath, input.workspace.registrationRoot);
  const relative = path.relative(input.workspace.registrationRoot, finalPath);
  const reference: ArtifactReference = {
    uri: artifactUri(input.lease.job.registrationId, relative),
    ...digest,
    createdAt: new Date().toISOString(),
  };
  await input.store.linkLeaseArtifact({
    token: input.lease.token,
    workerId: input.workerId,
    kind: input.kind,
    uri: reference.uri,
    sha256: reference.sha256,
    sizeBytes: reference.sizeBytes,
  });
  return reference;
}
