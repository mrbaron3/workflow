/** FEAT-019 — non-unit verification methods execute per AC and fail closed. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import type { IssueContract } from '../src/domain/schema.js';
import { EvalTask } from '../src/domain/schema.js';
import { groundArtifact } from '../src/pipeline/execution/grade.js';
import { runLoopLive } from '../src/pipeline/execution/live.js';
import { runRegressionTasks } from '../src/pipeline/regression.js';
import { Store } from '../src/store/store.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function contract(method: 'playwright' | 'api_test' | 'unit_test' | 'scope_check', ids = ['AC-E2E-001']): IssueContract {
  return {
    productGoal: 'Ground non-unit acceptance',
    userStory: 'As a user I receive evidence from the declared verification method',
    scope: { include: ['src/**'], exclude: [] },
    acceptanceCriteria: ids.map((id) => ({
      id,
      severity: 'blocker',
      behavior: `${id} is verified`,
      verification: { method, expected: [`${id} passes`] },
    })),
    redLines: [],
  };
}

function ground(
  c: IssueContract,
  graders: NonNullable<HarnessConfig['target']>['graders'] = {},
  graderEnvironment?: NodeJS.ProcessEnv,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-method-grader-'));
  roots.push(root);
  return groundArtifact({
    contract: c,
    target: { repo: '.', graders },
    worktree: root,
    branch: 'agent/test',
    changed: [],
    issueId: 'ISSUE-0042',
    ...(graderEnvironment ? { graderEnvironment } : {}),
  });
}

describe('verification-method command registry', () => {
  it('AC-GRDCMD-001/002 runs the configured method once per AC with criterion-scoped env', () => {
    const artifact = ground(
      contract('playwright', ['AC-E2E-001', 'AC-E2E-002']),
      {
        commands: {
          playwright: `node -e "process.exit(process.env.AGENTOPS_AC_ID==='AC-E2E-001'&&process.env.AGENTOPS_ISSUE_ID==='ISSUE-0042'?0:1)"`,
        },
      },
    );

    expect(artifact.satisfied).toEqual({ 'AC-E2E-001': true, 'AC-E2E-002': false });
    expect(artifact.verificationEvidence?.['AC-E2E-001']).toMatchObject({ method: 'playwright', passed: true });
    expect(artifact.verificationEvidence?.['AC-E2E-002']).toMatchObject({ method: 'playwright', passed: false });
  });

  it('AC-GRDCMD-003/004 rejects a non-unit AC when its command is absent and records why', () => {
    const artifact = ground(contract('api_test'));
    expect(artifact.satisfied['AC-E2E-001']).toBe(false);
    expect(artifact.apiTestsPass).toBe(false);
    expect(artifact.verificationEvidence?.['AC-E2E-001']).toEqual({
      method: 'api_test', command: null, passed: false, output: 'no configured grader command for api_test',
    });
    expect(artifact.notes.join('\n')).toContain('fail-closed');
  });

  it('AC-GRDCMD-003 also fails a unit_test AC closed when no live grader is configured', () => {
    const artifact = ground(contract('unit_test'));
    expect(artifact.satisfied['AC-E2E-001']).toBe(false);
    expect(artifact.unitTestsPass).toBe(false);
  });

  it('AC-GRDCMD-005 keeps scope_check intrinsic and command-free', () => {
    const artifact = ground(contract('scope_check'));
    expect(artifact.satisfied['AC-E2E-001']).toBe(true);
    expect(artifact.verificationEvidence?.['AC-E2E-001']).toMatchObject({
      method: 'scope_check', command: null, passed: true,
    });
  });

  it('ISSUE-0104 runs api_test with the same credential-free grader environment as unit/typecheck', () => {
    const artifact = ground(
      contract('api_test'),
      {
        commands: {
          api_test:
            'node -e "process.exit(process.env.AGENTOPS_GRADER_ENV_SENTINEL===\'ground-api\'?0:1)"',
        },
      },
      {
        PATH: process.env.PATH,
        AGENTOPS_GRADER_ENV_SENTINEL: 'ground-api',
      },
    );

    expect(artifact.apiTestsPass).toBe(true);
    expect(artifact.verificationEvidence?.['AC-E2E-001']).toMatchObject({
      method: 'api_test',
      passed: true,
    });
  });
});

describe('non-unit regression execution', () => {
  it('AC-GRDCMD-006 replays the captured method command with the same AC identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-method-regression-'));
    roots.push(root);
    const store = new Store(root);
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0042-AC-E2E-001',
      sourceIssueId: 'ISSUE-0042',
      featureArea: 'frontend',
      userGoal: 'browser flow remains green',
      expected: ['flow passes'],
      graders: ['playwright'],
      target: '.',
      graderCommands: { playwright: 'captured-playwright-command' },
      createdAt: '2026-07-15T00:00:00.000Z',
    }));
    const seen: Record<string, string> = {};
    const result = runRegressionTasks(store, { ...DEFAULT_CONFIG, target: { repo: '.' } }, {
      command: (_command, _cwd, env) => {
        Object.assign(seen, env);
        return { ok: true, output: 'browser evidence passed' };
      },
    });
    expect(seen).toMatchObject({
      AGENTOPS_AC_ID: 'AC-E2E-001',
      AGENTOPS_ISSUE_ID: 'ISSUE-0042',
      AGENTOPS_VERIFICATION_METHOD: 'playwright',
    });
    expect(result.results[0]).toMatchObject({ result: 'pass', matchedAssertions: 1 });
  });

  it('AC-GRDCMD-006 persists a non-zero command as fail with bounded diagnostics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-method-regression-'));
    roots.push(root);
    const store = new Store(root);
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0042-AC-API-001',
      sourceIssueId: 'ISSUE-0042',
      featureArea: 'backend',
      userGoal: 'API contract remains green',
      expected: ['status 200'],
      graders: ['api_test'],
      target: '.',
      graderCommands: { api_test: 'captured-api-command' },
      createdAt: '2026-07-15T00:00:00.000Z',
    }));
    const result = runRegressionTasks(store, { ...DEFAULT_CONFIG, target: { repo: '.' } }, {
      command: () => ({ ok: false, output: 'expected status 200, received 500' }),
    });
    expect(result.results[0]).toMatchObject({
      result: 'fail', matchedAssertions: 1, failedNames: ['expected status 200, received 500'],
    });
    expect(store.db.regressionRuns).toHaveLength(1);
  });

  it('ISSUE-0104 carries the live grader environment into turn-tail regression commands', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-method-live-regression-'));
    roots.push(root);
    const store = new Store(root);
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0042-AC-API-001',
      sourceIssueId: 'ISSUE-0042',
      featureArea: 'backend',
      userGoal: 'API dependency tree remains available',
      expected: ['dependency-backed API command passes'],
      graders: ['api_test'],
      target: '.',
      graderCommands: {
        api_test:
          'node -e "process.exit(process.env.AGENTOPS_GRADER_ENV_SENTINEL===\'live-regression\'?0:1)"',
      },
      createdAt: '2026-07-15T00:00:00.000Z',
    }));

    await runLoopLive(
      store,
      { ...DEFAULT_CONFIG, target: { repo: '.' } },
      root,
      {
        graderEnvironment: {
          PATH: process.env.PATH,
          AGENTOPS_GRADER_ENV_SENTINEL: 'live-regression',
        },
      },
    );

    expect(store.db.regressionRuns).toHaveLength(1);
    expect(store.db.regressionRuns[0]).toMatchObject({
      taskId: 'EVAL-TASK-ISSUE-0042-AC-API-001',
      result: 'pass',
    });
  });
});
