import { defineConfig, configDefaults } from 'vitest/config';

// Exclude the runtime store from test collection: `.harness/` holds the local store,
// the throwaway sandbox, and per-sample worktrees — each with their OWN test files that
// are graded by the execution layer, not part of the harness's own suite.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.harness/**'],
  },
});
