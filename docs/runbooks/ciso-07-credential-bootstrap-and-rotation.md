# CISO-07 credential bootstrap and rotation

The integrated topology has four deliberately different credential boundaries.
PostgreSQL administrator, control application, and runner roles use distinct passwords.
`mrbaron3/workflow` is private, so control writes only typed Issue/PR monitor requests to
PostgreSQL and never receives a GitHub credential. Only runner receives the current scoped
GitHub OAuth credential and returns bounded work identities through the durable broker. Codex uses either
`OPENAI_API_KEY` or a private `auth.json`; login-file mode copies that one regular file into
the managed `agentops-*-runner-credentials` volume and mounts the volume read-only at
`/run/agentops-credentials`. It never bind-mounts the Mac home directory.

## Bootstrap

1. Keep the lifecycle in `OFF`. Create distinct random values of at least 32 bytes for
   `AGENTOPS_POSTGRES_PASSWORD`, `AGENTOPS_CONTROL_DB_PASSWORD`,
   `AGENTOPS_RUNNER_DB_PASSWORD`, `AGENTOPS_CONTROL_TOKEN`,
   `AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN`, and `AGENTOPS_GITHUB_WEBHOOK_SECRET`.
2. Export `AGENTOPS_RUNNER_GITHUB_TOKEN` only in the operator process that invokes
   `agentopsctl`. Leave `AGENTOPS_CONTROL_GITHUB_TOKEN` unset. The runner credential may call
   only the fixed typed monitor endpoints and existing AgentOps GitHub operations through
   control's egress allowlist; no generic HTTP proxy exists. Values are inherited by Apple
   Container under environment keys and are never included in CLI arguments or evidence.
3. For Codex login-file mode, leave `OPENAI_API_KEY` unset and set
   `AGENTOPS_RUNNER_CODEX_AUTH_FILE` to the absolute private `auth.json`, mode `0600` or
   stricter. `agentopsctl` rejects symlinks, non-regular files, alternative filenames, and
   group/world-readable sources. A short-lived internal-network container receives the file
   on stdin, writes only `/credentials/codex/auth.json` in the named credential volume,
   changes ownership to uid/gid `65532`, verifies mode `0400`, and is removed. No host path
   or credential bytes enter runtime argv/logs; the source path is redacted from errors.
4. Run `agentopsctl start --mode MONITOR_ONLY --build`, register only
   `mrbaron3/workflow` through the Dashboard/API, verify readiness and repository state, then
   explicitly run `agentopsctl start --mode ACTIVE`.

## Rotation

1. Run `agentopsctl drain` and wait for the persisted state to be `DRAINING`, zero active
   leases/attempts, and runner stopped. Run `agentopsctl stop`; do not reseed a credential
   volume while a runner is attached.
2. Replace the intended operator-side values. For Codex login rotation, atomically replace
   only the private `auth.json`; never copy a whole home, `.codex` directory, SSH agent,
   development root, or container socket.
3. Start in `MONITOR_ONLY`. Migration/bootstrap is transactional: any invalid credential,
   failed copy, failed migration, readiness failure, or topology drift returns nonzero,
   records the failure when the database is available, compensates toward the prior safe
   mode, and is not rewritten as success.
4. Verify the new role can authenticate and the old role credential fails. Verify exact
   container mounts/publications and then explicitly return to `ACTIVE`.

Credential values, token prefixes, auth-file digests, and token fingerprints are forbidden
from committed logs and evidence. Evidence records only credential class, owner boundary,
file mode, and pass/fail results.
