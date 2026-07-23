import { spawnSync } from 'node:child_process';

/** Run one grounded command and include both output streams in deterministic failures. */
export function runCommand(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}
