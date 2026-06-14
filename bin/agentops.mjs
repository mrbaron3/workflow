#!/usr/bin/env node
// Thin launcher so `agentops <cmd>` works without a build step: it runs the
// TypeScript CLI through tsx. For local dev you can equivalently use the npm
// scripts (`npm run harness -- <cmd>`, `npm run demo`).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(root, 'src', 'cli', 'index.ts');

const res = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
