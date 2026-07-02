import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changedFiles } from '../src/pipeline/execution/worktree.js';

function tmpRepo(name: string): string {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  // Track src/ at baseline (like the sandbox's greet.ts) so a new file inside it shows as
  // an individual untracked path, not a collapsed `?? src/` directory entry.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'greet.ts'), 'export const g = 1;');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

// Regression: the first real end-to-end run reported request_changes on genuinely-correct
// work because the harness's own .agentops/ (PROMPT.md + sentinel) counted as scope creep.
describe('changedFiles excludes harness .agentops/ scaffolding', () => {
  it('lists agent edits but never the harness prompt/sentinel files', () => {
    const dir = tmpRepo('wt-scope');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'roman.ts'), 'export const x = 1;'); // agent edit
    fs.mkdirSync(path.join(dir, '.agentops'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agentops', 'PROMPT.md'), 'prompt'); // harness-owned
    fs.writeFileSync(path.join(dir, '.agentops', 'done.json'), '{"done":true}'); // harness-owned

    const changed = changedFiles(dir);
    expect(changed).toContain('src/roman.ts');
    expect(changed.some((f) => f.startsWith('.agentops'))).toBe(false);
  });
});
