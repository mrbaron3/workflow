import { describe, it, expect } from 'vitest';
import {
  AppleContainerRuntime,
  OciCliRuntime,
  RuntimeCommandError,
  VolumeMount,
  buildBuildArgs,
  buildRunArgs,
  hostArchitecture,
  normalizeOciArchitecture,
  parseContainerVersion,
  redactArgs,
  renderPublishFlag,
  renderVolumeFlag,
  type CommandResult,
  type CommandRunner,
  type ContainerSpec,
} from '../src/runtime/index.js';

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeRunner(
  handler: (command: string, args: string[]) => Partial<CommandResult> = () => ({}),
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = (command, args) => {
    const copied = [...args];
    calls.push({ command, args: copied });
    const result = handler(command, copied);
    return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runner, calls };
}

const fullSpec: ContainerSpec = {
  role: 'postgres',
  name: 'agentops-postgres',
  image: 'postgres:16',
  network: 'agentops-internal',
  publish: [{ hostIp: '127.0.0.1', hostPort: 17600, containerPort: 8080 }],
  volumes: [{ volume: 'agentops-postgres-data', mountPath: '/var/lib/postgresql/data', readOnly: false }],
  env: { POSTGRES_PASSWORD: 'x' },
  workdir: '/app',
  command: ['postgres', '-c', 'max_connections=50'],
};

describe('container-runtime adapter — neutral argv translation', () => {
  it('renders publish and volume flags in the shared docker-compatible form', () => {
    expect(renderPublishFlag({ hostIp: '127.0.0.1', hostPort: 17600, containerPort: 8080 }))
      .toBe('127.0.0.1:17600:8080');
    expect(renderVolumeFlag({ volume: 'v', mountPath: '/data' })).toBe('v:/data');
    expect(renderVolumeFlag({ volume: 'v', mountPath: '/data', readOnly: true })).toBe('v:/data:ro');
  });

  it('AC-CISO-011 renderVolumeFlag refuses a host bind mount source at the argv boundary', () => {
    expect(() => renderVolumeFlag({ volume: '/Users/alice/Company', mountPath: '/workspace' }))
      .toThrow('never a host bind mount');
    // Enforced even for an untyped runContainer call that skipped Zod .parse().
    const { runner } = fakeRunner();
    const docker = new OciCliRuntime('docker', runner);
    expect(() => docker.runContainer({
      role: 'runner', name: 'r', image: 'app', network: 'net', publish: [],
      volumes: [{ volume: '/Users/alice/Company', mountPath: '/workspace', readOnly: false }], env: {},
    })).toThrow('never a host bind mount');
  });

  it('AC-CISO-011 builds run argv from a runtime-neutral spec (publish, volume, env, workdir, command)', () => {
    expect(buildRunArgs(fullSpec)).toEqual([
      'run', '--detach', '--name', 'agentops-postgres', '--network', 'agentops-internal',
      '--publish', '127.0.0.1:17600:8080',
      '--volume', 'agentops-postgres-data:/var/lib/postgresql/data',
      '--env', 'POSTGRES_PASSWORD=x',
      '--workdir', '/app',
      'postgres:16', 'postgres', '-c', 'max_connections=50',
    ]);
  });

  it('omits absent optional fields from run argv', () => {
    expect(buildRunArgs({
      role: 'runner', name: 'r', image: 'app:dev', network: 'net', publish: [], volumes: [], env: {},
    })).toEqual(['run', '--detach', '--name', 'r', '--network', 'net', 'app:dev']);
  });

  it('builds multi-stage build argv with tag, file, target, and build-args', () => {
    expect(buildBuildArgs({
      image: 'app:dev', containerfile: 'deploy/Containerfile', contextDir: '.', target: 'build',
      buildArgs: { NODE_ENV: 'production' },
    })).toEqual([
      'build', '--tag', 'app:dev', '--file', 'deploy/Containerfile',
      '--target', 'build', '--build-arg', 'NODE_ENV=production', '.',
    ]);
  });
});

describe('container-runtime adapter — runtime-specific dialect isolation', () => {
  it('AC-CISO-011 uses Apple Container `network/volume delete` and `--time` stop', () => {
    const { runner, calls } = fakeRunner();
    const apple = new AppleContainerRuntime(runner);
    apple.removeNetwork('agentops-internal');
    apple.removeVolume('agentops-postgres-data');
    apple.stopContainer('agentops-control', { timeoutSeconds: 10 });
    expect(calls).toEqual([
      { command: 'container', args: ['network', 'delete', 'agentops-internal'] },
      { command: 'container', args: ['volume', 'delete', 'agentops-postgres-data'] },
      { command: 'container', args: ['stop', '--time', '10', 'agentops-control'] },
    ]);
  });

  it('uses docker `network/volume rm` for the generic OCI adapter — proving the boundary is neutral', () => {
    const { runner, calls } = fakeRunner();
    const docker = new OciCliRuntime('docker', runner);
    docker.removeNetwork('agentops-internal');
    docker.removeVolume('agentops-postgres-data');
    expect(calls).toEqual([
      { command: 'docker', args: ['network', 'rm', 'agentops-internal'] },
      { command: 'docker', args: ['volume', 'rm', 'agentops-postgres-data'] },
    ]);
  });

  it('fails closed with RuntimeCommandError (carrying both streams) on a non-zero exit', () => {
    const { runner } = fakeRunner((_cmd, args) =>
      args[0] === 'build' ? { status: 1, stderr: 'no such file' } : {});
    const apple = new AppleContainerRuntime(runner);
    expect(() => apple.buildImage({ image: 'app:dev', containerfile: 'nope', contextDir: '.' }))
      .toThrow(RuntimeCommandError);
    try {
      apple.buildImage({ image: 'app:dev', containerfile: 'nope', contextDir: '.' });
    } catch (error) {
      expect((error as RuntimeCommandError).message).toContain('no such file');
    }
  });

  it('AC-CISO-011 redacts --env/--build-arg secrets so a failed command never leaks a credential', () => {
    expect(redactArgs(['run', '--env', 'GITHUB_TOKEN=ghs-super-secret', 'img']))
      .toEqual(['run', '--env', 'GITHUB_TOKEN=***', 'img']);
    expect(redactArgs(['build', '--build-arg', 'NPM_TOKEN=abc', '.']))
      .toEqual(['build', '--build-arg', 'NPM_TOKEN=***', '.']);

    // The engine may echo the secret back on stderr — that must be scrubbed too, and the error object's
    // own args/result fields must already be redacted so even JSON.stringify(error) cannot leak it.
    const secret = 'ghs-super-secret';
    const { runner } = fakeRunner((_cmd, args) =>
      args[0] === 'run' ? { status: 1, stderr: `error: invalid token ${secret}` } : {});
    const apple = new AppleContainerRuntime(runner);
    try {
      apple.runContainer({
        role: 'runner', name: 'r', image: 'app:dev', network: 'net', publish: [], volumes: [],
        env: { GITHUB_TOKEN: secret },
      });
      expect.unreachable('runContainer should have thrown');
    } catch (caught) {
      const error = caught as RuntimeCommandError;
      expect(error.message).toContain('GITHUB_TOKEN=***');
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error.message).not.toContain(secret);
      expect(error.result.stderr).not.toContain(secret);
      expect(error.args).not.toContain(`GITHUB_TOKEN=${secret}`);
    }
  });
});

describe('container-runtime contracts — mount-source red line', () => {
  it('AC-CISO-011 rejects a host path as a volume source (no /Users bind mount is representable)', () => {
    expect(() => VolumeMount.parse({ volume: '/Users/alice/Company', mountPath: '/workspace' }))
      .toThrow();
    expect(() => VolumeMount.parse({ volume: 'agentops-data', mountPath: 'relative/path' }))
      .toThrow();
    expect(VolumeMount.parse({ volume: 'agentops-data', mountPath: '/var/lib/postgresql/data' }))
      .toMatchObject({ volume: 'agentops-data', mountPath: '/var/lib/postgresql/data', readOnly: false });
  });
});

describe('container-runtime adapter — capability probes (never throw)', () => {
  it('reports Apple Container available with version and running service', () => {
    const { runner } = fakeRunner((_cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'container CLI version 0.3.1 (build 42)' };
      if (args[0] === 'system' && args[1] === 'status') return { status: 0, stdout: 'running' };
      return {};
    });
    const capability = new AppleContainerRuntime(runner).capability();
    expect(capability).toMatchObject({ available: true, version: '0.3.1', serviceRunning: true });
  });

  it('reports Apple Container present but service down (actionable, not a false pass)', () => {
    const { runner } = fakeRunner((_cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'container CLI version 0.3.1' };
      return { status: 1, stderr: 'apiserver not running' };
    });
    const capability = new AppleContainerRuntime(runner).capability();
    expect(capability).toMatchObject({ available: true, serviceRunning: false });
    expect(capability.detail).toContain('system start');
  });

  it('reports Apple Container unavailable when the CLI is absent', () => {
    const { runner } = fakeRunner(() => ({ status: 127, stderr: 'command not found' }));
    const capability = new AppleContainerRuntime(runner).capability();
    expect(capability).toMatchObject({ available: false, version: null, serviceRunning: false });
  });

  it('reports the generic OCI engine reachable / down / absent distinctly', () => {
    const reachable = new OciCliRuntime('docker', fakeRunner((_c, a) => {
      if (a[0] === 'version') return { status: 0, stdout: '29.4.0\n' };
      if (a[0] === 'info') return { status: 0, stdout: 'aarch64\n' };
      return {};
    }).runner).capability();
    expect(reachable).toMatchObject({ available: true, serviceRunning: true, version: '29.4.0', architecture: 'arm64' });

    const daemonDown = new OciCliRuntime('docker', fakeRunner((_c, a) =>
      a[0] === '--version' ? { status: 0, stdout: 'Docker version 29.4.0' } : { status: 1 }).runner).capability();
    expect(daemonDown).toMatchObject({ available: true, serviceRunning: false });

    const absent = new OciCliRuntime('docker', fakeRunner(() => ({ status: 127 })).runner).capability();
    expect(absent).toMatchObject({ available: false });
  });

  it('parses versions and normalizes architectures', () => {
    expect(parseContainerVersion('container CLI version 0.3.1 (build 42)')).toBe('0.3.1');
    expect(parseContainerVersion('no version here')).toBeNull();
    expect(hostArchitecture('arm64')).toBe('arm64');
    expect(hostArchitecture('x64')).toBe('amd64');
    expect(hostArchitecture('ia32' as NodeJS.Architecture)).toBeNull();
    expect(normalizeOciArchitecture('x86_64')).toBe('amd64');
    expect(normalizeOciArchitecture('aarch64')).toBe('arm64');
    expect(normalizeOciArchitecture('mips')).toBeNull();
  });
});
