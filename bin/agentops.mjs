#!/usr/bin/env node
// Thin launcher so `agentops <cmd>` works without a build step: it runs the
// TypeScript CLI through tsx. For local dev you can equivalently use the npm
// scripts (`npm run harness -- <cmd>`, `npm run demo`).
import 'tsx/esm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'cli', 'index.ts');
await import(pathToFileURL(entry).href);
