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
  ISOLATED_GRADER_PORT_ALLOCATION_ATTEMPTS,
  ISOLATED_GRADER_MIN_PORT,
  ISOLATED_GRADER_PORT_COUNT,
  ISOLATED_GRADER_PORT_PROBE_DEADLINE_MS,
  ISOLATED_GRADER_PORT_PROBE_PROCESS_TIMEOUT_MS,
  ISOLATED_GRADER_PORT_WINDOW,
  isIsolatedPortRangeAvailable,
  prepareIsolatedExecutionResources,
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

async function canConnectToLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function dependencyBin(packageName: string, executable: string): string {
  const packageFile = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  return path.resolve(path.dirname(packageFile), '..', '.bin', executable);
}

describe('grader command env prefixes (KEY=VAL …)', () => {
  it.runIf(process.platform === 'darwin')('ISSUE-0024/PR-INTENT isolates a malicious head from operator credentials and network', async (context) => {
    const operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-operator-home-'));
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-untrusted-head-'));
    const sentinel = path.join(operatorHome, 'credential-sentinel');
    fs.writeFileSync(sentinel, 'secret');
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('network fixture did not bind');
    expect(await canConnectToLoopback(address.port)).toBe(true);
    const prepared = prepareIsolatedExecutionResources(process.execPath, ['--version'], checkout);
    try {
      const profile = prepared.args[1] ?? '';
      expect(profile).toContain('(allow network-outbound');
      expect(profile).not.toContain(`localhost:${address.port}`);
    } finally {
      prepared.cleanup();
    }
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
      context.skip();
      return;
    }
    expect(result, result.output).toMatchObject({ ok: true });
    expect(result.output).not.toContain('secret');
  });

  it('ISSUE-0024/PR-INTENT pins grader resource limits', () => {
    expect(GRADER_TIMEOUT_MS).toBe(600_000);
    expect(GRADER_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1_024);
    expect(ISOLATED_GRADER_MIN_PORT).toBe(30_000);
    expect(ISOLATED_GRADER_PORT_WINDOW).toBe(20_000);
    expect(ISOLATED_GRADER_PORT_COUNT).toBe(128);
    expect(ISOLATED_GRADER_PORT_ALLOCATION_ATTEMPTS).toBe(64);
    expect(ISOLATED_GRADER_PORT_ALLOCATION_ATTEMPTS).toBeGreaterThan(0);
    expect(ISOLATED_GRADER_PORT_PROBE_DEADLINE_MS).toBe(1_500);
    expect(ISOLATED_GRADER_PORT_PROBE_PROCESS_TIMEOUT_MS).toBe(2_000);
    expect(ISOLATED_GRADER_PORT_PROBE_PROCESS_TIMEOUT_MS)
      .toBeGreaterThan(ISOLATED_GRADER_PORT_PROBE_DEADLINE_MS);
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

  it.runIf(process.platform === 'darwin')('PR-INTENT permits only the configured external grader dependency tree', (context) => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-command-'));
    const result = runGraderCommand(
      `${dependencyBin('typescript', 'tsc')} --version`,
      checkout,
      {},
      { isolated: true },
    );
    fs.rmSync(checkout, { recursive: true, force: true });
    if (nestedSandboxUnavailable(result.output)) {
      context.skip();
      return;
    }
    expect(result, result.output).toMatchObject({ ok: true });
    expect(result.output).toContain('Version');
  });
  it.runIf(process.platform === 'darwin')('ISSUE-0024/PR-INTENT denies untrusted files under otherwise system-readable roots', (context) => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-untrusted-root-head-'));
    const prepared = prepareIsolatedExecutionResources(process.execPath, ['--version'], checkout);
    try {
      const profile = prepared.args[1] ?? '';
      expect(profile).not.toContain('(subpath "/Library")');
      expect(profile).not.toContain('(subpath "/opt")');
      expect(profile).toContain(
        '(subpath "/Library/Developer/CommandLineTools/usr/libexec/git-core")',
      );
      expect(profile).toContain(
        '(subpath "/Library/Developer/CommandLineTools/usr/share/git-core")',
      );
      expect(profile).toContain(
        '(literal "/Library/Developer/CommandLineTools/usr/bin/git")',
      );
    } finally {
      prepared.cleanup();
    }
    const untrustedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agentops-system-readable-'),
    );
    const sentinel = path.join(untrustedRoot, 'operator-secret');
    fs.writeFileSync(sentinel, 'secret');
    const result = runGraderCommand(
      `node -e "const fs=require('fs');try{fs.readFileSync('${sentinel}');process.exit(1)}catch{process.exit(0)}"`,
      checkout,
      {},
      { isolated: true },
    );
    fs.rmSync(untrustedRoot, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
    if (nestedSandboxUnavailable(result.output)) {
      context.skip();
      return;
    }
    expect(result, result.output).toMatchObject({ ok: true });
  });
  it.runIf(process.platform === 'darwin')('PR-INTENT starts Vitest without granting DNS or cross-sandbox loopback access', (context) => {
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
    if (nestedSandboxUnavailable(result.output)) {
      context.skip();
      return;
    }
    expect(result.output).not.toContain('getaddrinfo ENOTFOUND localhost');
    expect(result, result.output).toMatchObject({ ok: true });
  });
  it.runIf(process.platform === 'darwin')('ISSUE-0024/PR-INTENT prevents malicious PR code from modifying trusted dependencies', (context) => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-malicious-grader-'));
    const trustedPackage = createRequire(import.meta.url).resolve('typescript/package.json');
    const before = fs.readFileSync(trustedPackage, 'utf8');
    fs.writeFileSync(path.join(checkout, 'tsconfig.json'), '{}\n');
    fs.writeFileSync(
      path.join(checkout, 'malicious.test.ts'),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { expect, it } from 'vitest';",
        "it('cannot poison shared dependencies', () => {",
        "  const projected = path.join(process.cwd(), 'node_modules/typescript/package.json');",
        "  fs.writeFileSync(projected, '{\"poisoned\":true}\\n');",
        "  expect(fs.readFileSync(projected, 'utf8')).toContain('poisoned');",
        '});',
      ].join('\n'),
    );
    const result = runGraderCommand(
      `${dependencyBin('vitest', 'vitest')} run`,
      checkout,
      {},
      { isolated: true },
    );
    expect(fs.readFileSync(trustedPackage, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false);
    fs.rmSync(checkout, { recursive: true, force: true });
    if (nestedSandboxUnavailable(result.output)) {
      context.skip();
      return;
    }
    expect(result, result.output).toMatchObject({ ok: true });
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
