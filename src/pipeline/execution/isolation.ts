import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ISOLATED_GRADER_PORT_COUNT = 128;
export const ISOLATED_GRADER_MIN_PORT = 30_000;
export const ISOLATED_GRADER_PORT_WINDOW = 20_000;
export const ISOLATED_GRADER_PORT_ALLOCATION_ATTEMPTS = 64;
export const ISOLATED_GRADER_PORT_PROBE_DEADLINE_MS = 1_500;
export const ISOLATED_GRADER_PORT_PROBE_PROCESS_TIMEOUT_MS = 2_000;
export const NESTED_ISOLATED_GRADER_PORT_COUNT = 16;
const INHERITED_ISOLATED_GRADER_PORTS = 'AGENTOPS_ISOLATED_GRADER_PORTS';
const MACOS_GIT_SUPPORT_ROOTS = [
  '/Library/Developer/CommandLineTools/usr/libexec/git-core',
  '/Library/Developer/CommandLineTools/usr/share/git-core',
] as const;
const MACOS_GIT_EXECUTABLE = '/Library/Developer/CommandLineTools/usr/bin/git';

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
  trustedReadFiles: string[];
}

interface SandboxProfileInputs {
  cwd: string;
  home: string;
  tmp: string;
  rawSystemTmp: string;
  systemTmp: string;
  trustedReadRoots: string[];
  trustedReadFiles: string[];
  ports: number[];
}

function copyDependencyTree(source: string, destination: string): void {
  // APFS clonefile gives each untrusted grader a private copy-on-write tree
  // without paying for a full node_modules byte copy on every gate.
  const clone = spawnSync('/bin/cp', ['-cRLp', source, destination], {
    stdio: 'ignore',
    timeout: 60_000,
  });
  if (clone.status === 0) return;
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  });
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

function projectCommandDependencies(
  command: string,
  cwd: string,
  scratch: string,
): DependencyProjection {
  let destination: string | null = null;
  if (path.isAbsolute(command)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = command.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const dependencyRoot = fs.realpathSync(command.slice(0, markerIndex + marker.length - 1));
      const candidate = path.join(cwd, 'node_modules');
      if (fs.existsSync(candidate)) {
        throw new Error(`untrusted checkout must not provide node_modules: ${candidate}`);
      } else {
        const privateDependencyRoot = path.join(scratch, 'node_modules');
        copyDependencyTree(dependencyRoot, privateDependencyRoot);
        fs.mkdirSync(candidate);
        for (const entry of fs.readdirSync(privateDependencyRoot)) {
          if (entry === '.vite' || entry === '.vite-temp') continue;
          fs.symlinkSync(path.join(privateDependencyRoot, entry), path.join(candidate, entry));
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
    `setTimeout(()=>finish(1),${ISOLATED_GRADER_PORT_PROBE_DEADLINE_MS});`,
  ].join('');
  const result = spawnSync(nodeExecutable, ['-e', probe, String(base), String(count)], {
    stdio: 'ignore',
    timeout: ISOLATED_GRADER_PORT_PROBE_PROCESS_TIMEOUT_MS,
  });
  return result.status === 0;
}

function inheritedPortPool(): number[] {
  const raw = process.env[INHERITED_ISOLATED_GRADER_PORTS];
  if (!raw) return [];
  const ports = raw.split(',').map(Number);
  if (
    ports.length === 0
    || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error('invalid inherited isolated grader port policy');
  }
  return [...new Set(ports)].sort((left, right) => left - right);
}

function createPortPolicy(tmp: string): PortPolicy {
  const inherited = inheritedPortPool();
  if (inherited.length > 0) {
    const count = Math.min(NESTED_ISOLATED_GRADER_PORT_COUNT, inherited.length);
    for (let start = 0; start + count <= inherited.length; start += count) {
      const ports = inherited.slice(start, start + count);
      const base = ports[0]!;
      if (
        ports.every((port, index) => port === base + index)
        && isIsolatedPortRangeAvailable(base, count)
      ) {
        return { ports, lockDirectory: path.join(tmp, 'ports') };
      }
    }
    throw new Error('could not allocate a nested isolated grader port range');
  }

  for (let attempt = 0; attempt < ISOLATED_GRADER_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
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
  const trustedReadFiles = new Set<string>([nodeExecutable]);
  // CommandLineTools Git dispatches root-owned helpers and reads templates/config from
  // these two git-core trees. Grant those immutable trees, never /Library as a whole.
  for (const root of MACOS_GIT_SUPPORT_ROOTS) {
    if (fs.existsSync(root)) trustedReadRoots.add(root);
  }
  // Most git-core helpers are symlinks back to this one binary.
  if (fs.existsSync(MACOS_GIT_EXECUTABLE)) {
    trustedReadFiles.add(MACOS_GIT_EXECUTABLE);
  }
  const executable = resolveExecutable(command);
  if (executable && !executable.startsWith(`${cwd}${path.sep}`)) {
    const dependencyMarker = `${path.sep}node_modules${path.sep}`;
    const dependencyIndex = executable.lastIndexOf(dependencyMarker);
    if (dependencyIndex >= 0) {
      trustedReadRoots.add(executable.slice(0, dependencyIndex + dependencyMarker.length - 1));
    } else {
      trustedReadFiles.add(executable);
    }
  }
  return {
    trustedReadRoots: [...trustedReadRoots],
    trustedReadFiles: [...trustedReadFiles],
  };
}

function quoteProfileValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function renderSandboxProfile(inputs: SandboxProfileInputs): string {
  const quoted = quoteProfileValue;
  const {
    cwd, home, tmp, rawSystemTmp, systemTmp, trustedReadRoots, trustedReadFiles, ports,
  } = inputs;
  const trustedReadRules = trustedReadRoots.map((root) => `(subpath "${quoted(root)}")`).join(' ');
  const trustedFileRules = trustedReadFiles.map((file) => `(literal "${quoted(file)}")`).join(' ');
  const ancestorRules = [...trustedReadRoots, ...trustedReadFiles, cwd, home, tmp]
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
    '(allow file-read* file-test-existence (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share")',
    `  ${trustedReadRules} ${trustedFileRules} (subpath "${quoted(cwd)}") (subpath "${quoted(home)}") (subpath "${quoted(tmp)}"))`,
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
  ports: readonly number[],
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
    [INHERITED_ISOLATED_GRADER_PORTS]: ports.join(','),
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
    const dependencies = projectCommandDependencies(command, cwd, temporary.tmp);
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
      trustedReadFiles: trust.trustedReadFiles,
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
        ports.ports,
      ),
      cleanup: composeCleanup(resources),
    };
  } catch (error) {
    composeCleanup(resources)();
    throw error;
  }
}
