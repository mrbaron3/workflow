/**
 * Grader commands support sh-style leading KEY=VAL env assignments (ADR-0007 I3).
 * `run` in grade.ts uses spawnSync WITHOUT a shell, so `ACCEPT_HARNESS=1 vitest run`
 * would otherwise try to exec a binary literally named "ACCEPT_HARNESS=1". The env-gate
 * convention for self-hosted acceptance suites depends on this peeling.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import {
  GRADER_MAX_BUFFER_BYTES,
  GRADER_TIMEOUT_MS,
  groundArtifact,
  runGraderCommand,
} from '../src/pipeline/execution/grade.js';
import {
  ISOLATED_GRADER_MIN_PORT,
  ISOLATED_GRADER_PORT_COUNT,
  ISOLATED_GRADER_PORT_WINDOW,
  isIsolatedPortRangeAvailable,
} from '../src/pipeline/execution/isolation.js';
import type { IssueContract } from '../src/domain/schema.js';

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** Ground with only a typecheck grader — its exit code is the whole signal. */
function typecheckWith(command: string): boolean {
  const a = groundArtifact({
    contract,
    target: { repo: '.', graders: { typecheck: command } },
    worktree: process.cwd(),
    branch: 'test',
    changed: [],
  });
  return a.typecheckPasses;
}

function nestedSandboxUnavailable(output: string): boolean {
  return output.includes('sandbox_apply: Operation not permitted')
    || output.includes('terminated by signal: SIGABRT');
}

function dependencyBin(packageName: string, executable: string): string {
  const packageFile = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  return path.resolve(path.dirname(packageFile), '..', '.bin', executable);
}

describe('grader command env prefixes (KEY=VAL …)', () => {
  it.runIf(process.platform === 'darwin')('ISSUE-0024/PR-INTENT isolates a malicious head from operator credentials and network', async () => {
    const operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-operator-home-'));
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-untrusted-head-'));
    const sentinel = path.join(operatorHome, 'credential-sentinel');
    fs.writeFileSync(sentinel, 'secret');
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('network fixture did not bind');
    const result = runGraderCommand(
      `node -e "const fs=require('fs');let read=false;try{read=fs.readFileSync('${sentinel}','utf8')==='secret'}catch{};const leaked=process.env.SSH_AUTH_SOCK||process.env.GITHUB_TOKEN||process.env.HOME==='${operatorHome}'||read;const socket=require('net').connect(${address.port},'127.0.0.1');socket.once('connect',()=>process.exit(1));socket.once('error',()=>process.exit(leaked?1:0));setTimeout(()=>process.exit(1),500)"`,
      checkout,
      { SSH_AUTH_SOCK: '/operator/agent.sock', GITHUB_TOKEN: 'secret' },
      { isolated: true },
    );
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(operatorHome, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
    if (nestedSandboxUnavailable(result.output)) {
      // The outer CI sandbox forbids nesting sandbox-exec; production fails closed
      // in that case instead of falling back to credential-bearing host execution.
      expect(result.ok).toBe(false);
    } else {
      expect(result, result.output).toMatchObject({ ok: true });
      expect(result.output).not.toContain('secret');
    }
  });

  it('ISSUE-0024/PR-INTENT pins grader resource limits', () => {
    expect(GRADER_TIMEOUT_MS).toBe(600_000);
    expect(GRADER_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1_024);
    expect(ISOLATED_GRADER_MIN_PORT).toBe(30_000);
    expect(ISOLATED_GRADER_PORT_WINDOW).toBe(20_000);
    expect(ISOLATED_GRADER_PORT_COUNT).toBe(128);
  });

  it('ISSUE-0024/PR-INTENT excludes a range containing a pre-existing operator listener', async () => {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('network fixture did not bind');

    expect(isIsolatedPortRangeAvailable(address.port, 1)).toBe(false);

    await new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
  });
  it.runIf(process.platform === 'darwin')('PR-INTENT permits only the configured external grader dependency tree', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-command-'));
    const result = runGraderCommand(
      `${dependencyBin('typescript', 'tsc')} --version`,
      checkout,
      {},
      { isolated: true },
    );
    fs.rmSync(checkout, { recursive: true, force: true });
    if (!nestedSandboxUnavailable(result.output)) {
      expect(result, result.output).toMatchObject({ ok: true });
      expect(result.output).toContain('Version');
    }
  });
  it.runIf(process.platform === 'darwin')('PR-INTENT starts Vitest without granting DNS or cross-sandbox loopback access', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-vitest-'));
    fs.writeFileSync(
      path.join(checkout, 'isolated.test.ts'),
      "import { expect, it } from 'vitest'; it('runs', () => expect(1).toBe(1));\n",
    );
    fs.writeFileSync(path.join(checkout, 'tsconfig.json'), '{}\n');
    const result = runGraderCommand(
      `${dependencyBin('vitest', 'vitest')} run`,
      checkout,
      {},
      { isolated: true },
    );
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false);
    fs.rmSync(checkout, { recursive: true, force: true });
    if (!nestedSandboxUnavailable(result.output)) {
      expect(result.output).not.toContain('getaddrinfo ENOTFOUND localhost');
      expect(result, result.output).toMatchObject({ ok: true });
    }
  });
  it('a leading KEY=VAL lands in the child process env', () => {
    expect(typecheckWith(`AGENTOPS_GATE=on node -e process.exit(process.env.AGENTOPS_GATE==='on'?0:1)`)).toBe(true);
  });

  it('multiple leading assignments all apply', () => {
    expect(typecheckWith(`A=1 B=2 node -e process.exit(process.env.A==='1'&&process.env.B==='2'?0:1)`)).toBe(true);
  });

  it('without the prefix the variable is absent (no leakage between runs)', () => {
    expect(typecheckWith(`node -e process.exit(process.env.AGENTOPS_GATE===undefined?0:1)`)).toBe(true);
  });
});
