import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lease, RunnerJobPayloadV1 } from '../src/control-store/types.js';
import { verifyArtifactReferences } from '../src/runner/artifacts.js';
import {
  RunnerWorkspaceManager,
  artifactUri,
  registrationWorkspacePath,
  type WorkspaceCommandRunner,
} from '../src/runner/workspace.js';

const registrationId = 'ca3126a8-b83f-4698-90af-462523880c20';
const jobId = 'db837db2-30d7-4788-a56f-00056f5d550e';
const sha = 'a'.repeat(40);

function lease(): Lease {
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'runner-1',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 2,
    expiresAt: '2026-07-25T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: jobId,
      registrationId,
      registrationVersion: 3,
      source: { kind: 'manual', key: 'test' },
      idempotencyKey: 'test',
      jobType: 'agentops.runner',
      payload: {},
      status: 'leased',
      createdAt: '2026-07-25T00:00:00.000Z',
    },
  };
}

function payload(): RunnerJobPayloadV1 {
  return {
    schemaVersion: 1,
    repository: { owner: 'mrbaron3', name: 'workflow' },
    event: { kind: 'issue', number: 14, action: 'labeled' },
    target: { baseRef: 'refs/heads/main' },
    execution: {
      mode: 'development_turn',
      requiredChecks: [],
      mergeMethod: 'squash',
      readyLabel: 'ready',
      claimedLabel: 'agent-claimed',
    },
    artifacts: [],
  };
}

describe('Registration-rooted runner workspace', () => {
  it('derives deterministic paths only from the private root and Registration ID', () => {
    expect(registrationWorkspacePath('/workspace', registrationId))
      .toBe(`/workspace/registrations/${registrationId}`);
    expect(() => registrationWorkspacePath('/workspace', '../../escape')).toThrow();
    expect(artifactUri(registrationId, 'jobs/id/artifacts/result.json'))
      .toBe(
        `volume://registrations/${registrationId}/jobs/id/artifacts/result.json`,
      );
    expect(() => artifactUri(registrationId, '../outside')).toThrow();
  });

  it('uses a derived HTTPS clone URL and deterministic attempt worktree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-workspace-'));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: WorkspaceCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        const worktree = String(args[index + 4]);
        fs.mkdirSync(worktree, { recursive: true });
      }
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: `${sha}\n`, stderr: '' };
      }
      if (args.includes('get-url')) {
        return {
          status: 0,
          stdout: 'https://github.com/mrbaron3/workflow.git\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner);
    const prepared = manager.prepare(lease(), payload());
    expect(calls.find((call) => call.args[0] === 'clone')?.args).toContain(
      'https://github.com/mrbaron3/workflow.git',
    );
    expect(prepared.worktreePath).toBe(
      path.join(
        root,
        'registrations',
        registrationId,
        'jobs',
        jobId,
        'attempt-2',
        'worktree',
      ),
    );
    expect(prepared.statePath).toBe(
      path.join(root, 'registrations', registrationId, 'jobs', jobId, 'state'),
    );
    expect(prepared.headSha).toBe(sha);
  });

  it('accepts exact artifact digest/size and rejects tampering or cross-Registration reuse', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifact-'));
    const registrationRoot = registrationWorkspacePath(root, registrationId);
    const file = path.join(registrationRoot, 'inputs', 'review.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"approved":true}\n');
    const bytes = fs.readFileSync(file);
    const reference = {
      uri: artifactUri(registrationId, 'inputs/review.json'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .not.toThrow();
    fs.appendFileSync(file, 'tampered');
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .toThrow(/mismatch/);
    expect(() => verifyArtifactReferences(
      root,
      'db837db2-30d7-4788-a56f-00056f5d550e',
      [reference],
    )).toThrow(/another Registration/);
  });

  it('rejects an artifact whose parent symlink resolves outside the Registration root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifact-link-'));
    const registrationRoot = registrationWorkspacePath(root, registrationId);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-outside-'));
    const outsideFile = path.join(outside, 'review.json');
    fs.writeFileSync(outsideFile, '{"approved":true}\n');
    fs.mkdirSync(path.join(registrationRoot, 'inputs'), { recursive: true });
    fs.symlinkSync(outside, path.join(registrationRoot, 'inputs', 'linked'));
    const bytes = fs.readFileSync(outsideFile);
    const reference = {
      uri: artifactUri(registrationId, 'inputs/linked/review.json'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .toThrow(/outside the Registration workspace/);
  });
});
