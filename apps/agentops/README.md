# AgentOps TypeScript application

This directory is the package root for the TypeScript application. Application source,
tests, scripts, role prompts, and sample seeds live here; the Go control-plane application
lives separately under `apps/control-plane`.

Cross-application topology smoke drivers and the Go Control dashboard browser suite live
under root `deploy/scripts` and `deploy/test`; they are not part of this application's
source or unit-test boundary.

## Entrypoints

- `src/cli/index.ts` is the local harness/operator CLI, launched from the repository root
  with `npm run harness -- <command>`.
- `src/runner/cli.ts` is the isolated development runner and PostgreSQL job consumer.
- `src/triage/cli.ts` is the credential-limited triage and monitor worker.

The package builds the worker entrypoints as `dist/src/runner/cli.js` and
`dist/src/triage/cli.js`. `bin/agentops.mjs` is the no-build launcher for the harness CLI.

## Persistence boundaries

Go control and the TypeScript triage/runner processes coordinate through PostgreSQL's
`agentops_control` schema. The language-neutral inputs are owned by the repository root:

- `contracts/control-store/v1/` contains the versioned JSON contracts.
- `db/control-store/migrations/` contains the ordered SQL migration source of truth.

Normal application startup verifies the exact shared schema; it does not silently migrate
or fall back to a file store.

`.harness/db.json` is different. It is local state for the evaluation harness—issues,
evaluation runs, planning provenance, and review evidence. It is not the Go control-plane
source of truth and is not an application-to-application transport.

Application code may consume root-level shared contracts and migrations through
`src/runtime/roots.ts`. It must not import or read implementation files from
`apps/control-plane`.

## Validation

Run the workspace commands from the repository root:

```bash
npm run typecheck
npm run build
npm test
```

Run `npm run test:all` when validating both applications and the deploy integration layer.

PostgreSQL integration tests additionally require `AGENTOPS_TEST_DATABASE_URL` and run with
`npm run test:postgres`.
