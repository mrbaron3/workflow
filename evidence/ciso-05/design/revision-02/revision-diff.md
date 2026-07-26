# CISO-05 Experience Proposal — Revision 02

## Status and immutable lineage

This is the revised, independently authored proposal responding to the human `request-changes` decision for revision 01. It is **not approved**: implementation remains blocked until a separate Human Design Decision binds `approve` to this exact `revisionId` and `bundleDigest`.

| Field | Value |
| --- | --- |
| Source Issue | `mrbaron3/workflow#15`, snapshot revision `2026-07-25T07:10:01Z`, canonical digest `sha256:3293a23b56229c7c135eb9199bb0927ad46f0c6d22793ad326c9c554966b6d99` |
| Design Request | `workflow-ciso05-dashboard-20260726`, canonical digest `sha256:77629d9a1031fd7b7a26f6fe21b00f41e60d7bcb4247b5a5e7cc6fdb964f1099` |
| Parent / governing AC | `mrbaron3/workflow#10` / `AC-CISO-010` |
| Consumer implementation owner | `mrbaron3/workflow#15` |
| Designflow contract | `mrbaron3/designflow@contract-v1.0.0-rc.1`, commit `ce732a80a8c3867b4ac881531ce8f7546e001dbb` |
| Previous revision | `workflow-ciso05-dashboard-r01` |
| Rejected previous bundle | `sha256:56eb4d7283d6f1e2dd72cc931c48af2cee98c88103fc1709a106dd192725ba95` |
| Request-changes decision | `workflow-ciso05-dashboard-r01-request-changes` |
| New revision | `workflow-ciso05-dashboard-r02` |
| New bundle | `sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa` |
| Machine reconciliation | `evidence/ciso-05/design/revision-02/capability-reconciliation.json` |
| Human Design Decision | Not included; separate explicit review required |

## Executive diff from revision 01

| Area | Revision 01 | Revision 02 | Exact material change |
| --- | ---: | ---: | --- |
| Page purposes | 1 | 1 | Unchanged primary purpose and success outcome |
| Tasks / flows / effort budgets | 5 / 5 / 5 | 5 / 5 / 5 | IDs and numeric budgets unchanged; command and verification steps made exact |
| Regions / elements | 6 / 29 | 6 / 29 | No visible production element added or removed; placement/removal rationales preserved; security, truth, fence, and verification interaction rationales sharpened |
| Attention levels | 4 | 4 | Anomaly-first order and all region/element membership preserved |
| Capabilities | 7 | 7 | Same IDs; exact session, truth, duplicate, fence, outcome, and verification semantics added |
| Experience ambiguities | 4 | 0 | All four human-raised gaps closed |
| Capability ambiguities | 5 | 0 | All five human-raised gaps closed |
| Design-system decisions | 12 | 14 | Adds `component.command-verification-status` and `pattern.loopback-operator-session` decisions |
| Component deltas | 6 | 7 | Adds shared Command Verification Status contract |
| Pattern deltas | 4 | 5 | Adds exact loopback operator-session lifecycle |
| Token document | 1 | 1 | Byte-for-byte unchanged; existing semantic status/focus/responsive tokens remain sufficient |
| Preview states | 8 | 13 | Adds ACTIVE mode, session expiry, applied/verifying, duplicate, and indeterminate; strengthens five-component and verification fixtures |
| Capability reconciliation | absent | 7 / 7 | New machine-readable, implementation-owned mapping to operations, architecture, #15/AC-CISO-010, UI, semantics, and evidence |

## Preapproval owner-validation correction

Owner validation for revision 02 reported that a fresh 360 CSS px viewport had `document.documentElement.clientWidth = 360` and `scrollWidth = 380`. Independent reproduction at both 320 and 360 CSS px identified the same uncontained node: the Queue row’s actual-state `span.status-label`, with complete text `Depth 3 · leased job v12` and a right edge of 379.609375 CSS px.

- **Cause:** the reusable status label intentionally used `white-space: nowrap`, while the narrow component-matrix value column provided less than its 213.609375 CSS px intrinsic width. The component matrix also switched to its contractually required stacked form only through 720 CSS px rather than through the documented 767 CSS px boundary.
- **Correction:** the stacked component-matrix breakpoint is now exactly 767 CSS px; matrix grid items explicitly permit intrinsic shrinking; and status labels inside that matrix alone use normal wrapping with `overflow-wrap: anywhere`, a bounded maximum width, and a fixed-size status glyph. The complete desired, actual, freshness/observed/budget, last-good, last-error, and recovery content remains visible and untruncated.
- **Measured result:** fresh headless layouts report document `scrollWidth/clientWidth` of `320/320`, `360/360`, and `767/767`. The Queue label remains complete and wraps to 108 CSS px at 320, 148 CSS px at 360, and 213.609375 CSS px at 767; the intentionally horizontal state-lab controls remain contained within their own scroller at all three widths.
- **Provenance:** this preapproval correction was authored under Orca task `task_9bcf4a5422b6`, dispatch `ctx_26c26176794c`, now recorded alongside the original author invocation in `authorInvocationRefs`. It preserves `workflow-ciso05-dashboard-r02`, changes no capability, schema-bound experience/delta/token/requirements content, reconciliation mapping, ambiguity resolution, interaction, focus, or live-announcement contract, and does not constitute approval.

## Human change request 1 — seven capabilities reconciled

Every capability is owned by `mrbaron3/workflow#15` and `AC-CISO-010`. Existing `AC-CISO-001/002` remain lineage for the current #13 list/retry implementation and do not substitute for #15 ownership.

| Capability | Exact planned operation(s) | Architecture elements | UI / verification |
| --- | --- | --- | --- |
| `cap-establish-browser-control-session` | `GET /dashboard/bootstrap`; `GET /v1/browser-session`; `DELETE /v1/browser-session` | `ARCH-registration-control-009`, `-010` | bootstrap, session/expiry status, logout, rejection/expiry mutation lock |
| `cap-list-registration-status` | `GET /v1/registrations` | existing `-001`–`-003`, proposed `-011` | initial/refresh/list/detail plus authoritative verification for all commands |
| `cap-create-registration` | `POST /v1/registrations` | `-012`, `-013` | create dialog, structured outcome, identity/initial-version/desired re-query |
| `cap-update-registration` | `PATCH /v1/registrations/{registrationId}` | `-012`, `-013` | If-Match dialog, structured outcome, new-version/all-desired re-query |
| `cap-disable-registration` | `POST /v1/registrations/{registrationId}/disable` | `-012`, `-013` | destructive confirmation, old-work fence, disabled/version re-query |
| `cap-inspect-delivery-status` | `GET /v1/deliveries/{deliveryId}` | existing `-005`–`-006`, proposed `-014` | delivery/attempt/Registration/recovery inspection and verification |
| `cap-retry-delivery` | `POST /v1/deliveries/{deliveryId}/retry` | existing `-004`–`-006`, proposed `-012`–`-014` | attempts/version-fenced retry, structured attempt outcome, authoritative result |

`capability-reconciliation.json` carries, for every row, exact source interaction IDs, success/failure semantics, implementation obligations, and test-evidence obligations. Its coverage summary is 7 authored / 7 reconciled / 0 unreconciled.

### Architecture meanings made explicit

- `ARCH-registration-control-009`: loopback-only dashboard asset/bootstrap boundary. Browser access to PostgreSQL, providers, container runtime/socket, host filesystem, and non-Control-API hosts is forbidden.
- `ARCH-registration-control-010`: server-side browser-session boundary. A single-use script-free bootstrap is validated and redirected to a clean URL before assets load; the browser receives only an expiring opaque HttpOnly session cookie and a memory-only CSRF proof, never the existing bearer secret.
- `ARCH-registration-control-011`: exact `MONITOR_ONLY | ACTIVE` mode plus one consistent Registration-version-bound snapshot containing desired, actual, observed-at, freshness/reason, last-good, last error, and recovery for all five components.
- `ARCH-registration-control-012`: duplicate-safe structured outcomes. All mutations require a request-specific `Idempotency-Key`; update/disable also require `If-Match`; retry also requires observed route attempts and current Registration identity/version.
- `ARCH-registration-control-013`: one-time disable/version increment, transactional actor/outcome audit, queued old-version rejection, and a critical side-effect fence for leased old-version work.
- `ARCH-registration-control-014`: command acceptance is not completion. Authoritative Registration or Delivery re-query must match the command identity, resource identity, version/attempt, desired/delivery fields, and resulting recovery state before verified success.

These are proposed #15 obligations, not claims that the current base already implements them.

## Human change request 2 — same-origin loopback session closed exactly

The revised contract fixes one exact configured canonical origin including scheme, host, and port.

1. `GET /dashboard/bootstrap` is the only no-Origin exception. It is a script-free navigation that requires a loopback peer, exact Host, unexpired single-use token, and constant-time token comparison.
2. A successful bootstrap redirects to a clean URL before application assets load.
3. The server stores the operator session; the browser receives an opaque session ID cookie with `HttpOnly`, `SameSite=Strict`, path scope, expiry, and `Secure` when HTTPS.
4. `GET /v1/browser-session` returns only authentication state, expiry, and a non-secret CSRF proof. JavaScript keeps the proof in memory and sends `X-CSRF-Token` on each unsafe method.
5. Proof rotates at establishment/renewal and is invalidated at logout/expiry. It is forbidden from logs, persistent storage, URL, and DOM.
6. Every request validates exact Host. Unsafe methods require `Origin` byte-for-byte equal to the canonical origin and `Sec-Fetch-Site` compatible with same-origin. Missing, `null`, alternate loopback spelling, scheme/port/user-info/prefix/suffix variants fail closed before business input.
7. Existing bearer authentication remains non-browser only. Bearer, session ID, and CSRF proof are absent from HTML, JavaScript bundles, DOM, URL, persistent storage, response payload, and logs.
8. Required headers are restrictive same-origin CSP, `frame-ancestors 'none'`, no object/frame/base capability, `nosniff`, `no-referrer`, `no-store` for bootstrap/session/command data, and no permissive CORS.

The preview shows authenticated/expired session status and disables mutation on expiry without offering a bearer input.

## Human change request 3 — authoritative mode and five-component truth

The only authoritative mode values are `MONITOR_ONLY` and `ACTIVE`; unavailable mode is displayed as `Unknown`, never inferred. Dashboard mode mutation remains out of scope.

| Component | Desired source | Authoritative actual highlights | Freshness budget |
| --- | --- | --- | ---: |
| Issue Monitor | Registration `enabled && issueMonitorEnabled` | `starting \| running \| stopped \| failed \| disconnected \| unknown` | 300 s |
| PR Monitor | Registration `enabled && prMonitorEnabled` | `starting \| running \| stopped \| failed \| disconnected \| unknown` | 300 s |
| Forwarder | Registration `enabled` | `starting \| running \| stopped \| failed \| disconnected \| unknown` | 60 s |
| Execution | Registration `enabled && executionEnabled` | desired-on under MONITOR_ONLY is exactly `paused_by_mode`; ACTIVE uses only `running \| waiting \| idle \| failed \| stale \| unknown` from job/runner evidence | 30 s |
| Queue | Registration `enabled && executionEnabled` | durable depth plus active leased job ID/state/Registration version; `idle \| queued \| leased \| blocked_by_mode \| failed \| disconnected \| unknown` | 15 s |

Every row has separate `desired`, `actual`, `observedAt`, `freshness=fresh|stale|unknown`, `staleReason`, `lastGoodAt`, `lastError`, and `recoveryState`. Mode/snapshot budget is 15 seconds. A successful query time is not copied into component last-good; last-good is historical evidence only. Missing/failed evidence remains unknown, stale, failed, or disconnected. Disconnect retains prior data only as visibly last-known, disables mutation, and announces recovery only after a new authoritative successful snapshot.

## Human change request 4 — duplicate-safe fences and verified outcomes

The common structured outcome enum is:

`applied | duplicate | version_conflict | rejected | indeterminate`

- Create: request-specific `Idempotency-Key` plus normalized input/repository uniqueness; duplicate returns the same identity and initial version.
- Update: request-specific `Idempotency-Key` plus `If-Match`; same key/version/patch returns the same result without a second increment.
- Disable: request-specific `Idempotency-Key` plus `If-Match`; one version increment, queued old-version rejection, leased old-version critical side-effect fence.
- Retry: request-specific `Idempotency-Key` plus observed route attempts and current Registration identity/version; duplicate returns the same attempt.
- Same key/same normalized input converges to one durable outcome; same key/different input is rejected.
- Only transport uncertainty may reuse the same key with the exact same input. Version/attempt conflict is never blindly retried.
- A `2xx`/`202`, `applied`, or `duplicate` response is durable command evidence—not verified UI success.
- Verification re-queries `GET /v1/registrations` and/or `GET /v1/deliveries/{deliveryId}`. Exact identity, version/attempt, desired/delivery fields, and recovery result must match; otherwise the UI remains pending, conflict, rejected, or unknown.

The preview visibly separates applied/verifying, duplicate, rejected, conflict, indeterminate, and verified success and uses the same visible/live wording.

## Human change request 5 — no ambiguities; purpose and effort preserved

Both schema-bound ambiguity arrays are now empty. No uncertainty was hidden: every former ambiguity is resolved through the explicit proposed consumer obligations above, while approval remains a separate human action.

The Page Purpose text, five task IDs, six regions, twenty-nine production elements, and four attention levels are preserved. DOM order, visual order, and narrow-screen order remain:

1. global mode/session/connection truth and anomalies;
2. Registration identity, desired/actual/freshness/error/recovery evidence;
3. safe version/attempt-fenced actions;
4. filter, legend, pagination, and live support.

No element was added or removed. All twenty-nine retain requirement, purpose, task, region, placement rationale, interaction rationale, and removal impact. Interaction rationale was materially sharpened for `element-mode-status`, `element-connection-freshness`, `element-component-matrix`, `element-retry-delivery`, `element-command-outcome`, `element-registration-form`, `element-editor-actions`, and `element-disable-confirmation`.

### Effort Budgets — unchanged

| Task | Max primary actions | Max decisions | Max context switches | Repeated input |
| --- | ---: | ---: | ---: | --- |
| Anomaly diagnosis | 2 | 1 | 0 | No |
| Create Registration | 2 | 1 | 0 | No |
| Update desired state | 2 | 1 | 0 | No |
| Disable Registration | 2 | 2 | 0 | No |
| Recover failed delivery | 2 | 1 | 0 | No |

The post-command re-query is system work, not another operator action or decision. Conflict remains an intentional exception requiring a new human decision.

## Design-system delta

- `reuse`: Alert semantics remain unchanged.
- `extend`: Repository Status Card and Failure Recovery now expose exact mode/freshness/fence/outcome truth.
- `create`: existing connection banner, five-component matrix, delivery panel, anomaly/async/status-token decisions remain; new shared `component.command-verification-status` and `pattern.loopback-operator-session` are added.
- `feature-local`: Registration Editor and safe mutation remain local because allowlisted fields, version fences, and disable impact are product-specific.
- `design-tokens.json` is unchanged byte-for-byte. Existing foreground/background/border status triples, 3 px focus ring, 44 px target, panel spacing, and reduced-motion tokens cover the revision.

## Accessibility, focus, announcements, and responsive behavior

- Native buttons, search, checkbox, details, dialog, heading, table/definition semantics remain.
- Dialog initial focus, Tab containment, Escape/Cancel, error-summary focus, destructive non-autofocus, and trigger/selected-card focus return are preserved.
- Loading, selection, session expiry/rejection, disconnect, applied, duplicate, rejected, conflict, indeterminate, re-querying, and verified success have visible status and matching live text. Blocking failures are assertive once; routine progress is polite.
- At 320–767 CSS px, every component becomes a labeled vertical group containing desired, actual, freshness/observed/budget, last-good, last error, and recovery. No state, error, identity, or action is hidden and page-level horizontal overflow is forbidden.
- Status still requires text and shape/icon rather than color alone; 200% text zoom, 44 px targets, 3:1 focus indicator, long-value wrapping, and reduced-motion behavior remain.

## Artifact-level change record

| Artifact | Revision-02 change |
| --- | --- |
| `experience-contract.json` | Revision ID changed; exact session, mode/truth, command/fence, and verification flow/interaction semantics; both ambiguity gaps closed |
| `capability-requirements.json` | Revision ID changed; exact session lifecycle, freshness budgets, component states, mutation idempotency/fences, retry Registration version, structured verification; ambiguities empty |
| `design-system-delta.json` | Revision ID/token path changed; two decisions, one component, one pattern added; existing components/patterns strengthened |
| `design-tokens.json` | No content change; copied into the immutable new revision path |
| `preview.html` | New revision/lineage, thirteen state fixtures, exact session review, seven-capability table, five-component fields, applied-to-verified simulation; preapproval responsive correction wraps complete narrow matrix status labels and applies the stacked form through 767 CSS px |
| `capability-reconciliation.json` | New machine-readable 7/7 mapping and implementation/test obligations; not a schema-bound manifest slot |
| `design-bundle-manifest.json` | New bundle/revision identity, previous revision pointer, original and correction author invocations, paths, artifact digests, and recomputed bundle digest |

## Canonical digest record

Digest rules are the pinned `contract-v1.0.0-rc.1` rules: RFC 8785 JSON canonicalization before SHA-256 for JSON and `+json`; raw bytes for HTML; bundle digest after removing only top-level `bundleDigest`.

| Item | Digest |
| --- | --- |
| Design Request source digest | `sha256:77629d9a1031fd7b7a26f6fe21b00f41e60d7bcb4247b5a5e7cc6fdb964f1099` |
| `experience-contract.json` | `sha256:155483ed586bb35ac58f9f7d814e52a9e2d902fdca01b3f23bf2795f8e3d21ee` |
| `design-system-delta.json` | `sha256:51755c6165c2872c51524116b8b6c4dc17f0fd5f4d376b782142aeefd769cbba` |
| `design-tokens.json` | `sha256:e24a64c7294d3b519d97c31db479060d8bbe30b08281bc7b07f91620a804406d` |
| `capability-requirements.json` | `sha256:293006cc7b96b8e93155b3137b511bf49478dd06498690804bedd6a1efb51c12` |
| `preview.html` raw bytes | `sha256:f5860933f40de1e65811375a6261036793af6a0036a45bd0d65c5175a9ebffce` |
| Bundle manifest without `bundleDigest` | `sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa` |
| `capability-reconciliation.json` audit digest | `sha256:f67fed2c8de6836072cd8fb34ce53e70bf3801717989ba9c1dc25a1793d5a1db` |

## Validation record

- **Schema validation:** PASS — loaded all 7 canonical `contract-v1.0.0-rc.1` schemas with strict JSON Schema 2020-12/AJV formats and validated the Design Request, Experience Contract, Design System Delta, Capability Requirements, and Bundle Manifest. Design Tokens and reconciliation parsed as duplicate-free JSON.
- **RFC 8785 source/artifact/token/bundle digests:** PASS — independently recomputed the Design Request source digest, all five manifest artifact digests, the Design System Delta token-document digest, the reconciliation audit digest, and the manifest digest after removing only top-level `bundleDigest`.
- **Cross-trace validation:** PASS — 7 requirements, 1 purpose, 5 tasks, 5 flows / 16 unique steps, 5 Effort Budgets, 6 regions, 29 elements, 4 attention levels, 7 capabilities, 14 decisions, 7 components, and 5 patterns are unique and fully referenced; every region/element appears in the hierarchy and preview.
- **Capability reconciliation validation:** PASS — exact authored/reconciled ID equality, exact operation set, defined architecture refs, exact #15/AC-CISO-010 ownership, exact interaction-set equality, non-empty implementation/test obligations, 7/7 coverage, 0 unreconciled, and empty ambiguities.
- **Headless preview validation:** PASS — Google Chrome 150 exercised anomaly, ACTIVE, loading, empty, stale, disconnected, session-expired, applied, duplicate, rejected, conflict, indeterminate, verified, retry fences, dialog initial/error/cancel focus, applied→authoritative-verification timing, AX dialog/button/heading roles, and zero external resources/console errors. Fresh explicit responsive assertions at 320, 360, and 767 CSS px each returned `document.documentElement.scrollWidth <= clientWidth` (`320/320`, `360/360`, `767/767`), complete stacked component fields and Queue status text, and an internally contained horizontal state-lab scroller.

Residual verification is deliberately implementation-owned: this static proposal cannot prove a future Control API session, Origin/CSRF enforcement, PostgreSQL persistence, old-work fence, or vendor/device boundary. `capability-reconciliation.json` names the required API, integration, security, persistence, Playwright, responsive, and accessibility evidence that #15 must produce after human approval.
