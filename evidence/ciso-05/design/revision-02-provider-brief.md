# CISO-05 revision-02 independent design-provider brief

## Authority and immutable lineage

- Source request: `evidence/ciso-05/design/design-request.json`
- Source issue snapshot: `evidence/ciso-05/design/source-issue-15.json`
- Requested revision: `workflow-ciso05-dashboard-r02`
- Previous revision: `workflow-ciso05-dashboard-r01`
- Rejected bundle digest: `sha256:56eb4d7283d6f1e2dd72cc931c48af2cee98c88103fc1709a106dd192725ba95`
- Human request-changes record: `evidence/ciso-05/design/decisions/request-changes-r01.json`
- Designflow contract: repository-pinned `contracts/designflow/contract-v1.0.0-rc.1` and canonical implementation at `/Users/yu/Company/Development/designflow` tag `contract-v1.0.0-rc.1`

The provider must independently inspect the sources and contracts, make its own design judgments, and author only `evidence/ciso-05/design/revision-02/**`. Product implementation, API contracts, system documentation, tests, Git, GitHub, and the prior revision/decision are out of bounds.

## Human-requested changes that revision 02 must close

1. Reconcile all seven authored capabilities to concrete Control API operations, architecture/system elements, and `AC-CISO-010`.
2. Define a same-origin loopback operator session, exact Origin validation, and CSRF lifecycle without exposing the existing bearer secret to browser code.
3. Define authoritative `MONITOR_ONLY | ACTIVE` mode and truthful desired/actual/freshness/last-good/recovery semantics for Issue Monitor, PR Monitor, Forwarder, Execution, and Queue.
4. Make create, update, disable, and retry outcomes duplicate-safe, version-fenced, structured, and let the UI announce verified success only after an authoritative re-query confirms the requested durable state.
5. Remove every ambiguity while preserving the anomaly-first attention hierarchy and every primary-task Effort Budget.

## Concrete consumer contract available for reconciliation

Revision 02 must include a human-readable and machine-readable capability reconciliation. The machine-readable file may live beside the schema-bound bundle artifacts as `capability-reconciliation.json`; it must list, for every one of the seven capability IDs, exact planned HTTP operations, concrete architecture IDs, issue/AC ownership, UI interactions, success/failure semantics, and implementation/test evidence obligations.

The following planned Control API and system elements are available to the provider. They are proposals for the #15 implementation, not claims about the current base:

| Capability | Planned HTTP operations | Architecture elements | Ownership |
| --- | --- | --- | --- |
| `cap-establish-browser-control-session` | `GET /dashboard/bootstrap`, `GET /v1/browser-session`, `DELETE /v1/browser-session` | `ARCH-registration-control-009`, `ARCH-registration-control-010` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |
| `cap-list-registration-status` | `GET /v1/registrations` | existing `ARCH-registration-control-001`–`003`, plus `ARCH-registration-control-011` | issue `mrbaron3/workflow#15`, `AC-CISO-010` (existing #13 trace to AC-CISO-001/002 remains lineage, not substitute ownership) |
| `cap-create-registration` | `POST /v1/registrations` | `ARCH-registration-control-012`, `ARCH-registration-control-013` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |
| `cap-update-registration` | `PATCH /v1/registrations/{registrationId}` | `ARCH-registration-control-012`, `ARCH-registration-control-013` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |
| `cap-disable-registration` | `POST /v1/registrations/{registrationId}/disable` | `ARCH-registration-control-012`, `ARCH-registration-control-013` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |
| `cap-inspect-delivery-status` | `GET /v1/deliveries/{deliveryId}` | existing `ARCH-registration-control-005`–`006`, plus `ARCH-registration-control-014` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |
| `cap-retry-delivery` | `POST /v1/deliveries/{deliveryId}/retry` | existing `ARCH-registration-control-004`–`006`, plus `ARCH-registration-control-012`–`014` | issue `mrbaron3/workflow#15`, `AC-CISO-010` |

Architecture element meanings to make explicit in the reconciliation and revision diff:

- `ARCH-registration-control-009`: loopback-only dashboard asset/bootstrap boundary; no browser access to PostgreSQL, providers, container runtime/socket, or non-Control-API hosts.
- `ARCH-registration-control-010`: server-side browser-session boundary. A one-time bootstrap token is consumed by a script-free navigation at the exact configured loopback Host and redirected to a clean URL before application assets load. The existing long-lived bearer secret is never returned to or entered in browser code. The resulting opaque session ID is `HttpOnly`, `Secure` when HTTPS, `SameSite=Strict`, path-scoped, expiring, and held server-side.
- `ARCH-registration-control-011`: authoritative operating-mode and component truth projection. Mode is exactly `MONITOR_ONLY | ACTIVE`; each of Issue Monitor, PR Monitor, Forwarder, Execution, and Queue returns desired, actual, observed-at, freshness/stale reason, last-good, last error, and recovery state from a consistent Registration-version-bound snapshot. Missing or failed evidence is `unknown`, `stale`, `failed`, or `disconnected`, never inferred healthy.
- `ARCH-registration-control-012`: duplicate-safe structured command outcome. Every mutation requires a request-specific `Idempotency-Key`; update and disable also require the observed Registration version through `If-Match`; retry requires observed route attempts and the current Registration version. Same key/same input converges to one durable outcome, while same key/different input is rejected.
- `ARCH-registration-control-013`: disable/version fencing and transactional audit. Disabling increments the version once, records the actor/outcome, rejects queued old-version work, and prevents already leased old-version work from crossing the next critical side-effect fence. Structured outcomes distinguish applied, duplicate, version conflict, rejected, and indeterminate/transport uncertainty.
- `ARCH-registration-control-014`: authoritative recovery projection and verification. Command acceptance is not completion. The UI re-queries the authoritative Registration or Delivery resource and announces verified success only when identity, version, desired fields, attempt identity, and resulting actual/recovery state match the command outcome; otherwise it shows pending, conflict, rejected, or unknown.

## Required session, Origin, CSRF, and security semantics

- The server binds loopback and has one exact configured canonical origin, including scheme, host, and port.
- All dashboard/API requests validate the exact `Host`; unsafe browser methods require `Origin` byte-for-byte equal to the canonical origin and `Sec-Fetch-Site` compatible with same-origin. Missing, `null`, alternate loopback spelling, suffix/prefix, port, scheme, and user-info variants fail closed. The one-time script-free bootstrap navigation is the only no-Origin exception and must validate loopback peer, exact Host, expiry, single use, and constant-time token comparison.
- `GET /v1/browser-session` returns authentication/expiry plus a non-secret CSRF proof; application JavaScript keeps the proof in memory and sends it in `X-CSRF-Token` on every unsafe method. Rotate the proof at session establishment and renewal, invalidate it on logout/expiry, never place it in logs or persistent browser storage, and reject missing/mismatched proof before business input handling.
- Browser application requests authenticate only through the opaque HttpOnly session cookie. Existing bearer authentication remains a non-browser Control API path and is never placed in HTML, JavaScript, storage, DOM, URL, or response payload.
- Static assets are same-origin and self-contained. Security headers include a restrictive CSP (`default-src 'self'`, `connect-src 'self'`, no object/frame/base capability), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, strict referrer policy, no caching of bootstrap/session/command data, and no permissive CORS.

## Required truth and outcome semantics

- `MONITOR_ONLY` makes an enabled/execution-enabled Registration's Execution actual state `paused_by_mode`, not failed and not running. `ACTIVE` may show `running`, `waiting`, `idle`, `failed`, `stale`, or `unknown` only from authoritative job/runner evidence.
- Queue actual state reports durable depth and active leased job/version from the database snapshot. Queue/Execution desired and actual remain separate; a successful query timestamp is not automatically a component last-good timestamp.
- Every component has a bounded freshness budget and explicit `fresh | stale | unknown` result with observed-at and reason. Last-good is historical evidence only and never paints a current failure as healthy.
- Database/API disconnect keeps any prior data only as visibly last-known, carries its last-good timestamp, disables mutation, and announces recovery only after a new authoritative successful snapshot.
- Update, disable, and retry dialogs show the version/attempts being fenced. A `2xx` command response is accepted/applied evidence, not verified UI success. Verification requires the authoritative follow-up query described by `ARCH-registration-control-014`.

## Revision artifacts and validation

Create a complete `revision-02` bundle with the same schema-bound artifact set as revision 01, a self-contained human-viewable `preview.html`, a precise `revision-diff.md`, and the machine-readable reconciliation. Use a new bundle/revision identity and recompute every artifact digest and the bundle digest exactly per Designflow RFC 8785 rules. Every `ambiguities` array must be empty; every task/flow/region/element/capability/design-system reference must cross-trace; the preview must visibly exercise the revised mode, session/disconnect, five-component truth, structured outcome, re-query verification, keyboard/focus/live-announcement, and responsive behavior without weakening the existing Page Purpose, attention order, placement/removal rationales, or Effort Budgets.
