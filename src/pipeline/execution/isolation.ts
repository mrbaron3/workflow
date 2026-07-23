import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ISOLATED_GRADER_PORT_COUNT = 128;
export const ISOLATED_GRADER_MIN_PORT = 30_000;
export const ISOLATED_GRADER_PORT_WINDOW = 20_000;

export interface IsolatedExecution {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

interface TemporaryResources {
  home: string;
  tmp: string;
  cleanup: () => void;
}

interface DependencyProjection {
  cleanup: () => void;
}

interface PortPolicy {
  ports: number[];
  lockDirectory: string;
}

interface GeneratedPreload {
  filename: string;
  cleanup: () => void;
}

interface TrustPolicy {
  trustedReadRoots: string[];
}

interface SandboxProfileInputs {
  cwd: string;
  home: string;
  tmp: string;
  rawSystemTmp: string;
  systemTmp: string;
  trustedReadRoots: string[];
  ports: number[];
}

function createTemporaryResources(): TemporaryResources {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-home-')));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-tmp-')));
  return {
    home,
    tmp,
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function projectCommandDependencies(command: string, cwd: string): DependencyProjection {
  let destination: string | null = null;
  if (path.isAbsolute(command)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = command.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const dependencyRoot = fs.realpathSync(command.slice(0, markerIndex + marker.length - 1));
      const candidate = path.join(cwd, 'node_modules');
      if (fs.existsSync(candidate)) {
        if (fs.realpathSync(candidate) !== dependencyRoot) {
          throw new Error(`untrusted checkout already contains a different node_modules: ${candidate}`);
        }
      } else {
        fs.mkdirSync(candidate);
        for (const entry of fs.readdirSync(dependencyRoot)) {
          if (entry === '.vite' || entry === '.vite-temp') continue;
          fs.symlinkSync(path.join(dependencyRoot, entry), path.join(candidate, entry));
        }
        destination = candidate;
      }
    }
  }
  return {
    cleanup: () => {
      if (destination && fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    },
  };
}

export function isIsolatedPortRangeAvailable(
  base: number,
  count: number,
  nodeExecutable: string = process.execPath,
): boolean {
  if (!Number.isInteger(base) || !Number.isInteger(count) || base < 1 || count < 1) return false;
  const probe = [
    "const net=require('node:net');",
    'const base=Number(process.argv[1]); const count=Number(process.argv[2]);',
    'const servers=[]; let settled=false; let listening=0;',
    'const finish=(code)=>{ if(settled)return; settled=true;',
    '  for(const server of servers){try{server.close()}catch{}}',
    '  setTimeout(()=>process.exit(code),0);',
    '};',
    'for(let offset=0;offset<count;offset+=1){',
    '  const server=net.createServer(); servers.push(server);',
    "  server.once('error',()=>finish(1));",
    "  server.listen(base+offset,'127.0.0.1',()=>{listening+=1;if(listening===count)finish(0)});",
    '}',
    'setTimeout(()=>finish(1),1500);',
  ].join('');
  const result = spawnSync(nodeExecutable, ['-e', probe, String(base), String(count)], {
    stdio: 'ignore',
    timeout: 2_000,
  });
  return result.status === 0;
}

function createPortPolicy(tmp: string): PortPolicy {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const base = ISOLATED_GRADER_MIN_PORT
      + Math.floor(Math.random() * ISOLATED_GRADER_PORT_WINDOW);
    if (!isIsolatedPortRangeAvailable(base, ISOLATED_GRADER_PORT_COUNT)) continue;
    return {
      ports: Array.from({ length: ISOLATED_GRADER_PORT_COUNT }, (_, index) => base + index),
      lockDirectory: path.join(tmp, 'ports'),
    };
  }
  throw new Error('could not reserve a collision-free isolated grader port range');
}

function writeLocalhostPreload(
  cwd: string,
  policy: PortPolicy,
): GeneratedPreload {
  const filename = path.join(
    cwd,
    `.agentops-localhost-dns-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`,
  );
  fs.writeFileSync(filename, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const dns = require('node:dns');",
    "const net = require('node:net');",
    'const original = dns.promises.lookup.bind(dns.promises);',
    'dns.promises.lookup = async (hostname, options) => {',
    "  if (hostname !== 'localhost') return original(hostname, options);",
    "  if (options && options.all) return [{ address: '127.0.0.1', family: 4 }];",
    "  return { address: '127.0.0.1', family: 4 };",
    '};',
    `const allowedPorts = ${JSON.stringify(policy.ports)};`,
    `const lockDir = ${JSON.stringify(policy.lockDirectory)};`,
    'fs.mkdirSync(lockDir, { recursive: true });',
    'let portCursor = Math.abs(process.pid) % allowedPorts.length;',
    'function claimPort() {',
    '  for (let tried = 0; tried < allowedPorts.length; tried += 1) {',
    '    const port = allowedPorts[portCursor++ % allowedPorts.length];',
    "    try { fs.closeSync(fs.openSync(path.join(lockDir, String(port)), 'wx')); return port; } catch {}",
    '  }',
    "  throw new Error('isolated grader exhausted its local test port allowance');",
    '}',
    'const originalListen = net.Server.prototype.listen;',
    'net.Server.prototype.listen = function isolatedListen(...args) {',
    "  if (typeof args[0] === 'number' && args[0] === 0) args[0] = claimPort();",
    "  else if (args[0] && typeof args[0] === 'object' && args[0].port === 0) {",
    '    args[0] = { ...args[0], port: claimPort() };',
    '  }',
    '  return originalListen.apply(this, args);',
    '};',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  return {
    filename,
    cleanup: () => fs.rmSync(filename, { force: true }),
  };
}

function resolveExecutable(command: string): string | null {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? fs.realpathSync(command) : null;
  }
  for (const entry of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching the operator-owned PATH.
    }
  }
  return null;
}

function resolveTrustPolicy(
  command: string,
  cwd: string,
  nodeExecutable: string,
): TrustPolicy {
  const trustedReadRoots = new Set<string>([path.dirname(path.dirname(nodeExecutable))]);
  const executable = resolveExecutable(command);
  if (executable && !executable.startsWith(`${cwd}${path.sep}`)) {
    let cursor = path.dirname(executable);
    while (cursor !== path.dirname(cursor) && path.basename(cursor) !== 'node_modules') {
      cursor = path.dirname(cursor);
    }
    trustedReadRoots.add(
      path.basename(cursor) === 'node_modules' ? cursor : path.dirname(executable),
    );
  }
  return { trustedReadRoots: [...trustedReadRoots] };
}

function quoteProfileValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function renderSandboxProfile(inputs: SandboxProfileInputs): string {
  const quoted = quoteProfileValue;
  const { cwd, home, tmp, rawSystemTmp, systemTmp, trustedReadRoots, ports } = inputs;
  const trustedReadRules = trustedReadRoots.map((root) => `(subpath "${quoted(root)}")`).join(' ');
  const ancestorRules = [...trustedReadRoots, cwd, home, tmp]
    .map((root) => `(path-ancestors "${quoted(root)}")`).join(' ');
  const localTestPorts = ports.map((port) => `(local tcp "localhost:${port}")`).join(' ');
  const remoteTestPorts = ports.map((port) => `(remote tcp "localhost:${port}")`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal (target children))',
    '(allow sysctl-read)',
    `(allow file-read-metadata file-test-existence ${ancestorRules})`,
    '(deny file-read* file-test-existence',
    `  (require-all (subpath "${quoted(systemTmp)}")`,
    `    (require-not (subpath "${quoted(cwd)}"))`,
    `    (require-not (subpath "${quoted(home)}"))`,
    `    (require-not (subpath "${quoted(tmp)}"))`,
    `    (require-not (path-ancestors "${quoted(cwd)}"))`,
    `    (require-not (path-ancestors "${quoted(home)}"))`,
    `    (require-not (path-ancestors "${quoted(tmp)}"))))`,
    '(deny file-write*',
    `  (require-all (subpath "${quoted(systemTmp)}")`,
    `    (require-not (subpath "${quoted(cwd)}"))`,
    `    (require-not (subpath "${quoted(home)}"))`,
    `    (require-not (subpath "${quoted(tmp)}"))))`,
    '(allow file-read* file-test-existence (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/opt")',
    `  ${trustedReadRules} (subpath "${quoted(cwd)}") (subpath "${quoted(home)}") (subpath "${quoted(tmp)}"))`,
    `(allow file-write* (subpath "${quoted(cwd)}") (subpath "${quoted(home)}") (subpath "${quoted(tmp)}"))`,
    ...(rawSystemTmp === systemTmp ? [] : [
      '(deny file-read* file-test-existence',
      `  (require-all (subpath "${quoted(rawSystemTmp)}")`,
      `    (require-not (subpath "${quoted(cwd)}"))`,
      `    (require-not (subpath "${quoted(home)}"))`,
      `    (require-not (subpath "${quoted(tmp)}"))`,
      `    (require-not (path-ancestors "${quoted(cwd)}"))`,
      `    (require-not (path-ancestors "${quoted(home)}"))`,
      `    (require-not (path-ancestors "${quoted(tmp)}"))))`,
      '(deny file-write*',
      `  (require-all (subpath "${quoted(rawSystemTmp)}")`,
      `    (require-not (subpath "${quoted(cwd)}"))`,
      `    (require-not (subpath "${quoted(home)}"))`,
      `    (require-not (subpath "${quoted(tmp)}"))))`,
    ]),
    `(allow network-bind network-inbound ${localTestPorts})`,
    `(allow network-outbound ${remoteTestPorts})`,
  ].join('\n');
}

function isolatedEnvironment(
  cwd: string,
  home: string,
  tmp: string,
  nodeExecutable: string,
  preload: string,
): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: [
      path.dirname(nodeExecutable),
      path.join(cwd, 'node_modules', '.bin'),
      '/opt/homebrew/bin',
      '/Library/Developer/CommandLineTools/usr/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter),
    TMPDIR: tmp,
    LANG: process.env.LANG ?? 'C',
    NODE_OPTIONS: `--require=${preload}`,
  };
}

function composeCleanup(resources: Array<{ cleanup: () => void }>): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const resource of resources.slice().reverse()) resource.cleanup();
  };
}

export function prepareIsolatedExecutionResources(
  command: string,
  args: string[],
  checkout: string,
): IsolatedExecution {
  if (process.platform !== 'darwin') {
    throw new Error('untrusted grader isolation is unavailable on this platform');
  }
  const resources: Array<{ cleanup: () => void }> = [];
  try {
    const cwd = fs.realpathSync(checkout);
    const temporary = createTemporaryResources();
    resources.push(temporary);
    const dependencies = projectCommandDependencies(command, cwd);
    resources.push(dependencies);
    const ports = createPortPolicy(temporary.tmp);
    const preload = writeLocalhostPreload(cwd, ports);
    resources.push(preload);
    const nodeExecutable = fs.realpathSync(process.execPath);
    const trust = resolveTrustPolicy(command, cwd, nodeExecutable);
    const profile = renderSandboxProfile({
      cwd,
      home: temporary.home,
      tmp: temporary.tmp,
      rawSystemTmp: os.tmpdir(),
      systemTmp: fs.realpathSync(os.tmpdir()),
      trustedReadRoots: trust.trustedReadRoots,
      ports: ports.ports,
    });
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, command, ...args],
      env: isolatedEnvironment(
        cwd,
        temporary.home,
        temporary.tmp,
        nodeExecutable,
        preload.filename,
      ),
      cleanup: composeCleanup(resources),
    };
  } catch (error) {
    composeCleanup(resources)();
    throw error;
  }
}
