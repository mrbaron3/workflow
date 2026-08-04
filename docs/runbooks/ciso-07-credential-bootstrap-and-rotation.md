# CISO-07 credential bootstrap and rotation

The integrated topology has separate PostgreSQL administrator, control, triage, and development
runner database roles. Control writes only typed Issue/PR monitor requests to PostgreSQL and never
receives a GitHub credential. A dedicated internal-only GitHub App broker is the only process that
reads the App private key. Triage and the development runner receive distinct broker capabilities;
their `gh`/Git helpers request repository/permission-scoped installation tokens in memory at each
operation. Static PATs and a shared operator `gh auth` credential are rejected. Codex uses either
`OPENAI_API_KEY` or a private `auth.json`; login-file mode copies that one regular file into
the managed per-role credential volumes (`agentops-*-triage-credentials` for triage,
`agentops-*-runner-credentials` for the development runner) and mounts each volume read-only at
`/run/agentops-credentials`. Roles never share a credential volume — named volumes attach to a
single VM exclusively, so a shared volume would make the second consumer fail to start. It never
bind-mounts the Mac home directory.

## Bootstrap

1. Keep the lifecycle in `OFF`. Create distinct random values of at least 32 bytes for
   `AGENTOPS_POSTGRES_PASSWORD`, `AGENTOPS_CONTROL_DB_PASSWORD`,
   `AGENTOPS_TRIAGE_DB_PASSWORD`, `AGENTOPS_RUNNER_DB_PASSWORD`, `AGENTOPS_CONTROL_TOKEN`,
   `AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN`, and `AGENTOPS_GITHUB_WEBHOOK_SECRET`.
   Create no broker capability by hand. Holding a capability is the right to mint that role's
   GitHub installation token, so it must never be derived from — or set equal to — any database
   password or operator token. `agentopsctl` therefore generates one distinct 43-character
   URL-safe value per role on first use and keeps them in
   `${AGENTOPSCTL_STATE_DIR:-~/.agentops}/<prefix>/broker-capabilities.json`, a mode-0600 file in
   a mode-0700 directory. Every later command reads the same values back, so a running topology
   keeps matching its desired spec. The store is refused — not regenerated — if it is group or
   world accessible, if its directory is (write permission there is substitution permission), if
   the store or its directory belongs to another account, if its directory is a symlink, or if its
   contents are unreadable, unversioned, or share one value across both roles. The ownership check
   is what holds when the permission bits stop deciding access — a privileged `agentopsctl`
   traverses any directory, and an ACL can grant what the mode does not express. Only root may
   `chown`, so a principal who can write an ancestor of the state directory can replace that
   directory but cannot forge whose it is. Set
   `AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY` and `AGENTOPS_GITHUB_BROKER_RUNNER_CAPABILITY`
   only to keep an external secret manager authoritative; supplying both means no store is ever
   written, and `agentopsctl` still rejects a value reused from another credential. The runner
   capability is required in `ACTIVE`.
2. Create one GitHub App owned by the same account as every monitored repository. Disable
   webhooks and grant only this repository permission union: Actions read, Checks read,
   Contents write, Issues write, Pull requests write, Commit statuses read, and Workflows write.
   Select only the repositories represented by durable Registrations when installing it. Record the
   numeric App id, installation id, canonical slug, and owner as
   `AGENTOPS_GITHUB_APP_ID`, `AGENTOPS_GITHUB_APP_INSTALLATION_ID`,
   `AGENTOPS_GITHUB_APP_SLUG`, and `AGENTOPS_GITHUB_APP_OWNER`. Save the generated private key as
   one absolute `.pem` file with mode `0600` or stricter and set
   `AGENTOPS_GITHUB_APP_PRIVATE_KEY_FILE`. Repository scope is resolved from the current enabled
   PostgreSQL Registration at every broker claim; there is no process environment allowlist or
   second repository source of truth. Leave `GH_TOKEN`, `GITHUB_TOKEN`, and every
   `AGENTOPS_*_GITHUB_TOKEN` unset.

   `agentopsctl` validates the RSA PEM, streams it over stdin into the
   `agentops-*-github-app-key` named volume, and mounts it read-only only in
   `agentops-*-github-broker`. The broker verifies App/installation identity and mints exact role
   scopes before reporting ready. `MONITOR_ONLY` triage receives Contents/Issues/Pull requests
   read. `ACTIVE` triage receives Contents read, Issues write, Pull requests read. `ACTIVE` runner
   receives the claimed Registration repository plus the development permission set.
3. For Codex login-file mode, leave `OPENAI_API_KEY` unset and set
   `AGENTOPS_RUNNER_CODEX_AUTH_FILE` to the absolute private `auth.json`, mode `0600` or
   stricter. `agentopsctl` rejects symlinks, non-regular files, alternative filenames, and
   group/world-readable sources. A short-lived internal-network container receives the file
   on stdin, writes only `/credentials/codex/auth.json` in the named credential volume,
   changes ownership to uid/gid `65532`, verifies mode `0400`, and is removed. No host path
   or credential bytes enter runtime argv/logs; the source path is redacted from errors.
4. Run `agentopsctl start --mode MONITOR_ONLY --build`, create a Registration for every intended
   repository through the Dashboard/API, and verify readiness and repository state.
   The Registration is the durable repository authority. `MONITOR_ONLY` starts
   PostgreSQL, control, GitHub App broker, and triage only; triage receives no provider token/Codex credential
   volume and cannot classify or promote an Issue. Then explicitly run
   `agentopsctl deploy`. The deploy command verifies a clean exact source HEAD, drains any current
   ACTIVE leases, rebuilds every image, migrates, promotes through MONITOR_ONLY, and then enters
   ACTIVE. ACTIVE adds provider egress/auth to triage, performs a
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
   control, triage, and runner database roles. Broker capabilities are independent secrets, so
   rotating a database password does not rotate them and rotating a capability does not touch the
   database. To rotate the generated capabilities, delete
   `${AGENTOPSCTL_STATE_DIR:-~/.agentops}/<prefix>/broker-capabilities.json` while `OFF`; the next
   command generates a fresh pair and the next start replaces broker and workers as one desired
   topology. Deleting the store rotates both roles at once — it is one file — and it must be done
   while `OFF`, because a broker already running holds the previous values and would be reported
   as drift. To rotate one role alone, or to hand rotation to an external secret manager, export
   the new `AGENTOPS_GITHUB_BROKER_*_CAPABILITY` value while `OFF` instead; an exported value wins
   over the store. For Codex login rotation, atomically replace only the private `auth.json`;
   never copy a whole home, `.codex` directory, SSH agent, development root, or container socket.
3. Start in `MONITOR_ONLY`. Migration/bootstrap is transactional: any invalid credential,
   failed copy, failed migration, readiness failure, or topology drift returns nonzero,
   records the failure when the database is available, compensates toward the prior safe
   mode, and is not rewritten as success. A running PostgreSQL container is bound to the
   sealed image digest and credential-redacted canonical spec. Actual credential values are
   compared only in memory and verified with bounded authentication probes; no label or
   evidence digest is derived from credential bytes. Mutable-tag, spec, or authentication
   drift requires this volume-preserving drain/stop/restart path and is never silently
   accepted.
4. GitHub installation tokens rotate automatically and are never operator-managed. To rotate the
   App private key, while `OFF` generate a second key in GitHub, atomically replace the private
   `AGENTOPS_GITHUB_APP_PRIVATE_KEY_FILE`, start `MONITOR_ONLY`, and verify broker readiness and a
   poll before deleting the prior key in GitHub. To change repositories or permissions, update
   the GitHub App installation first, update the durable Registration, and restart; the broker
   fails closed if the issued token returns a different repository or permission set.
5. Verify each rotated role can authenticate and its old credential fails. Verify exact
   container mounts/publications and then explicitly return to `ACTIVE`.

Credential values, PEM/JWT/token prefixes, auth-file digests, and token fingerprints are forbidden
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
