import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export default defineConfig({
  root: repositoryRoot,
  test: {
    include: ['deploy/test/**/*.test.ts'],
  },
});
