# CISO-07 credential bootstrap and rotation

The integrated topology has separate PostgreSQL administrator, control, triage, and development
runner database roles. Control writes only typed Issue/PR monitor requests to PostgreSQL and never
receives a GitHub credential. Triage receives the monitor/Issue GitHub credential and returns
bounded work identities through the durable broker; the development runner receives a different
GitHub credential only in `ACTIVE`. Codex uses either
`OPENAI_API_KEY` or a private `auth.json`; login-file mode copies that one regular file into
the managed `agentops-*-runner-credentials` volume and mounts the volume read-only at
`/run/agentops-credentials`. It never bind-mounts the Mac home directory.

## Bootstrap

1. Keep the lifecycle in `OFF`. Create distinct random values of at least 32 bytes for
   `AGENTOPS_POSTGRES_PASSWORD`, `AGENTOPS_CONTROL_DB_PASSWORD`,
   `AGENTOPS_TRIAGE_DB_PASSWORD`, `AGENTOPS_RUNNER_DB_PASSWORD`, `AGENTOPS_CONTROL_TOKEN`,
   `AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN`, and `AGENTOPS_GITHUB_WEBHOOK_SECRET`.
2. Export a triage token as `AGENTOPS_TRIAGE_GITHUB_TOKEN`. It needs repository metadata/content
   read plus Issues read/write for the configured repositories, but not Contents write,
   Pull Requests write, workflow, administration, or package permissions. In `ACTIVE`, export a
   different development token as `AGENTOPS_RUNNER_GITHUB_TOKEN` with the minimum permissions
   needed by the existing claim/branch/PR/check/merge path. Leave
   `AGENTOPS_CONTROL_GITHUB_TOKEN` unset. Values are inherited by Apple Container under
   environment keys and are never included in CLI arguments or evidence.
3. For Codex login-file mode, leave `OPENAI_API_KEY` unset and set
   `AGENTOPS_RUNNER_CODEX_AUTH_FILE` to the absolute private `auth.json`, mode `0600` or
   stricter. `agentopsctl` rejects symlinks, non-regular files, alternative filenames, and
   group/world-readable sources. A short-lived internal-network container receives the file
   on stdin, writes only `/credentials/codex/auth.json` in the named credential volume,
   changes ownership to uid/gid `65532`, verifies mode `0400`, and is removed. No host path
   or credential bytes enter runtime argv/logs; the source path is redacted from errors.
4. Set `AGENTOPS_MONITOR_REPOSITORIES` to a comma-separated 1–64 item canonical allowlist.
   Run `agentopsctl start --mode MONITOR_ONLY --build`, create a Registration for every intended
   repository through the Dashboard/API, and verify readiness and repository state.
   The allowlist and Registration are separate mandatory fences. `MONITOR_ONLY` starts
   PostgreSQL, control, and triage broker only; it receives no provider token/Codex credential
   volume and cannot classify or promote an Issue. Then explicitly run
   `agentopsctl start --mode ACTIVE`. ACTIVE adds provider egress/auth to triage, performs a
   bounded nonlogging provider-authentication probe, and starts the separately credentialed
   development runner.

## Rotation

1. Run `agentopsctl drain` and wait for the persisted state to be `DRAINING`, zero active
   leases/attempts, and triage/runner stopped. To rotate the PostgreSQL administrator, keep this
   state at `DRAINING`, export a new distinct value of at least 32 bytes as
   `AGENTOPS_NEXT_POSTGRES_PASSWORD`, and run
   `agentopsctl rotate-postgres-admin --request-id <unique-id>`. The short-lived admin
   container performs one transactional `ALTER ROLE` plus audit append, verifies that the
   next password authenticates and the prior password no longer does, and never places
   either value in argv or logs. The command rejects `OFF`, `MONITOR_ONLY`, `ACTIVE`, live
   leases, in-flight attempts, reused application-role passwords, and reused administrator
   passwords.
2. Immediately promote the verified next administrator value to
   `AGENTOPS_POSTGRES_PASSWORD`, then run `agentopsctl stop` with that verified value and
   unset `AGENTOPS_NEXT_POSTGRES_PASSWORD` only after `OFF` is observed. The old value can
   no longer authenticate, so using it for `stop` intentionally fails closed. Do not reseed
   any credential volume while a runner is attached. Replace any other intended
   operator-side values while `OFF`; the next bootstrap transaction rotates the distinct
   control, triage, and runner database roles. For Codex login rotation, atomically replace
   only the private `auth.json`; never copy a whole home, `.codex` directory, SSH agent,
   development root, or container socket.
3. Start in `MONITOR_ONLY`. Migration/bootstrap is transactional: any invalid credential,
   failed copy, failed migration, readiness failure, or topology drift returns nonzero,
   records the failure when the database is available, compensates toward the prior safe
   mode, and is not rewritten as success. A running PostgreSQL container is bound to the
   sealed image digest and credential-redacted canonical spec. Actual credential values are
   compared only in memory and verified with bounded authentication probes; no label or
   evidence digest is derived from credential bytes. Mutable-tag, spec, or authentication
   drift requires this volume-preserving drain/stop/restart path and is never silently
   accepted.
4. Verify each rotated role can authenticate and its old credential fails. Verify exact
   container mounts/publications and then explicitly return to `ACTIVE`.

Credential values, token prefixes, auth-file digests, and token fingerprints are forbidden
from committed logs and evidence. Evidence records only credential class, owner boundary,
file mode, and pass/fail results.

## Migration and failure rollback boundary

Schema migration is additive, checksum-gated, and committed in one PostgreSQL transaction
before control or runner replacement. A migration error leaves the prior schema unchanged.
After version 7 commits, rollback means scoped compensation to the previous safe lifecycle
mode with the PostgreSQL volume and broker/triage rows intact, followed by forward recovery with a
version-7-aware image. Starting an older consumer against a committed version-7 database
intentionally fails its version gate; no destructive down migration is
offered because deleting broker requests, leases, digests, and audits would violate the
durability contract.
