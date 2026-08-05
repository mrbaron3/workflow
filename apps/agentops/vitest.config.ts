import { defineConfig, configDefaults } from 'vitest/config';
import { REPOSITORY_ROOT } from './src/runtime/roots.js';

// Exclude the runtime store from test collection: `.harness/` holds the local store,
// the throwaway sandbox, and per-sample worktrees — each with their OWN test files that
// are graded by the execution layer, not part of the harness's own suite.
//
// `dist/**` is excluded explicitly and must stay that way. `npm run build` compiles
// test/ alongside src/ (tsconfig includes both so `tsc --noEmit` typechecks the suite),
// so a build leaves compiled copies of every test under dist/test/. Those copies go
// stale the moment source moves on, and vitest 4 dropped `**/dist/**` from
// configDefaults.exclude — so without this line, running `npm run build` once makes
// `npm test` permanently red with failures that exist only in the stale build output.
// dist/ itself is a real artifact (dist/src/{runner,triage}/cli.js are the container
// entrypoints), so the build must keep emitting it; only collection is wrong.
export default defineConfig({
  root: REPOSITORY_ROOT,
  test: {
    include: ['apps/agentops/test/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'dist/**',
      'apps/agentops/dist/**',
      '.harness/**',
    ],
  },
});
