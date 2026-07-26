# CISO-05 Experience Proposal — Revision 01

## Status and lineage

This is the **INITIAL, unapproved proposal** for `mrbaron3/workflow#15`.

| Field | Value |
| --- | --- |
| Source Issue | `mrbaron3/workflow#15`, snapshot revision `2026-07-25T07:10:01Z` |
| Parent / governing AC | `mrbaron3/workflow#10` / `AC-CISO-010` |
| Reconciliation owner | `mrbaron3/workflow#13` |
| Design Request | `workflow-ciso05-dashboard-20260726` |
| Revision | `workflow-ciso05-dashboard-r01` |
| Previous pinned revision | `design-revision-001` |
| Previous pinned bundle | `sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97` |
| Proposal bundle | `sha256:56eb4d7283d6f1e2dd72cc931c48af2cee98c88103fc1709a106dd192725ba95` |
| Human Design Decision | **Not created** |
| Implementation gate | **Blocked by unresolved ambiguities, human review, and #13 capability reconciliation** |

The previous revision is the pinned Designflow `contract-v1.0.0-rc.1` Dashboard example. It supplies the baseline purpose, anomaly-first card, alert, failure-recovery pattern, and the two original capabilities. This revision does not claim that the baseline’s human approval applies to CISO-05; the request, revision, artifacts, digest, and unresolved capability surface are new.

## Executive diff from `design-revision-001`

| Area | Pinned baseline | Revision 01 | Material change |
| --- | ---: | ---: | --- |
| Page purposes | 1 | 1 | Primary purpose preserved and grounded in Registration operations, truthful freshness, last-good, and safe actions |
| Tasks / flows / effort budgets | 2 / 2 / 2 | 5 / 5 / 5 | Adds create, update, disable, and separates safe delivery recovery while keeping diagnosis primary |
| Regions | 3 | 6 | Adds anomaly overview, complete Registration detail, dedicated delivery recovery, and progressive Registration editor |
| Elements | 4 | 29 | Traces every visible production element to purpose, tasks, requirements, placement, interaction, and removal impact |
| Attention levels | 2 | 4 | Separates global truth/anomalies, diagnostic evidence, safe mutation, and supporting controls |
| Backend capabilities | 2 | 7 | Adds browser session security, create, update, disable, and independent delivery inspection |
| Design-system decisions | 3 | 12 | Records `reuse`, `extend`, `create`, and `feature-local` decisions |
| Component deltas | 1 | 6 | Adds connection/freshness banner, desired/actual matrix, delivery recovery panel, and feature-local editor |
| Pattern deltas | 1 | 4 | Extends failure recovery and adds anomaly-first, truthful async, and safe mutation patterns |
| Explicit ambiguities | 0 / 0 | 4 experience / 5 capability | Keeps current #13 gaps implementation-blocking instead of treating them as resolved |

## Purpose, tasks, and effort change

The single primary purpose remains:

> 異常のあるRepositoryを発見し、desired stateとactual stateの差、原因、影響、最終正常時刻を理解して安全な次の操作を選ぶ。

The baseline diagnosis flow is extended to include Control API connection truth, authoritative mode, five component categories, time evidence, and recovery. The baseline delivery retry flow is split into inspection and command capabilities so a read and a mutation no longer share one capability kind.

| Task | Criticality | Maximum primary actions | Maximum decisions | Context switches | Repeated input |
| --- | --- | ---: | ---: | ---: | --- |
| Anomaly diagnosis | Primary | 2 | 1 | 0 | No |
| Create Registration | Secondary | 2 | 1 | 0 | No |
| Update desired state | Secondary | 2 | 1 | 0 | No |
| Disable Registration | Safety | 2 | 2 | 0 | No |
| Recover failed delivery | Safety | 2 | 1 | 0 | No |

Disable intentionally keeps confirmation friction: the operator must verify the target/version and the effect on monitors, forwarder, execution, queue, and old work. Version or attempt conflicts require a new human decision and are not silently retried.

## Attention hierarchy change

1. **Global truth and anomaly:** operating mode, Control API connection/freshness, failed/disconnected/stale/divergent Registration, desired/actual matrix, last error, recovery, and command outcome.
2. **Diagnostic evidence:** desired flags, observed and last-good timestamps, last poll/delivery, queue depth, active job, and failed delivery identity/attempts.
3. **Safe mutation:** create, update, disable, strict validation, version fence, confirmation, and dialog actions.
4. **Supporting navigation:** purpose copy, state legend, filter, pagination, and visible live announcements.

The preview’s DOM order, visual order, and responsive order follow this hierarchy. On narrow viewports the component table becomes labeled per-component groups; status, error, timestamps, and actions are not hidden.

## Truthful state matrix

| State | Required representation | Forbidden representation | Recovery |
| --- | --- | --- | --- |
| Loading | Result region is `aria-busy`; explicit loading copy; neutral skeleton | Skeleton or retained value presented as healthy | Wait; replace with fresh, empty, or disconnected |
| Empty | Fresh authoritative response with zero Registrations; “登録なし” | “All healthy” or a blank list | Register a repository if authorized |
| Stale | Stale label, observed time, last-good, freshness reason | Current healthy or verified success | Bounded poll or manual refresh |
| Disconnected | Current state unavailable, last successful read, last known labeling; mutation disabled | Cached values presented as current | Restore Control API/store and refresh |
| Rejected | Reason, recoverability, preserved input/context; no mutation | Success toast or closed dialog | Correct input/session or stop |
| Conflict | Current version/attempt and reload path | Automatic overwrite or blind retry | Re-query and make a new human decision |
| Accepted / pending | Attempt or command accepted; processing not complete | Completed or successful | Inspect durable state |
| Verified success | Persisted identity/version confirmed by authoritative re-query | Success based only on request acceptance | Observe actual-state convergence |

## Region and element rationale

The complete per-region and per-element rationale is normative in `experience-contract.json`. The following summarizes the placement logic:

- Global mode and connection appear first because every status and mutation depends on them.
- Anomaly summary and filtering appear before the Registration list to reduce scan cost.
- Registration cards keep identity, version, primary anomaly, desired state, and last-good in a stable comparison position.
- Selected detail keeps immutable identity/version before desired state, desired before actual, and actual before timestamps, error, and actions.
- Recovery appears after the failure explanation and includes delivery identity, attempts, Registration version, retry, and outcome in one context.
- Create/update/disable inputs are progressive dialogs. They cannot introduce arbitrary configuration fields.
- Destructive disable follows the diagnostic evidence, is separated from edit, and has its own confirmation.

Removing any of the 29 contract elements has an explicit impact. No decorative data or action without a purpose/task/requirement trace was added.

## Design-system delta

| Action | Targets | Rationale |
| --- | --- | --- |
| `reuse` | `component.alert` | Baseline cause/impact-before-action semantics remain valid |
| `extend` | `component.repository-status-card`, `pattern.failure-recovery`, focus/layout token surface | Adds version, freshness, last-good, mode impact, state truth, and conflict semantics |
| `create` | Connection/Freshness Banner, Desired/Actual Matrix, Delivery Recovery Panel, anomaly-first and truthful-state patterns, semantic status tokens | The baseline has no complete global truth, five-component comparison, or async truth contract |
| `feature-local` | Registration Editor and safe Registration mutation pattern | Registration fields, version fences, forbidden input boundary, and disable impact must not leak into a generic form |

`design-tokens.json` separates primitive, semantic, and component tokens. Status tokens define foreground/background/border triples; every status still requires text and shape/icon semantics. Focus ring, 44px target, panel spacing, and reduced-motion behavior are explicit.

## Backend Capability Requirements

No capability requirement invents a concrete endpoint. Each describes user intent, inputs, success, failure, authorization, latency, freshness, concurrency, idempotency, retry, cancellation, pagination, and audit:

1. `cap-establish-browser-control-session`
2. `cap-list-registration-status`
3. `cap-create-registration`
4. `cap-update-registration`
5. `cap-disable-registration`
6. `cap-inspect-delivery-status`
7. `cap-retry-delivery`

The experience allows only a same-origin Control API adapter. Browser-to-PostgreSQL, browser-to-runner, provider API calls, container lifecycle, Apple Container socket access, arbitrary command/path/image/mount/credential input, and mode mutation are excluded.

## #13 API and capability gaps

These are known gaps, not implementation instructions. #13 must translate the approved future capability revision into concrete API/system contracts and coverage evidence.

| Gap | Current evidence | Required reconciliation |
| --- | --- | --- |
| Browser operator session / Origin / CSRF | `internal/control/api.go` accepts a bearer token; there is no browser session bootstrap, exact Origin validation, CSRF lifecycle, or browser security-header contract | Map `cap-establish-browser-control-session` to a same-origin operator boundary without exposing the bearer secret to browser code |
| Static Dashboard serving | `cmd/agentops-control/main.go` installs only the Control API handler; no static asset route or same-origin browser bootstrap is defined | Define how built assets and the API share the loopback origin while preserving the single Control API boundary |
| Authoritative operating mode | `RegistrationProjection` and the OpenAPI status response have no global `OFF` / `MONITOR_ONLY` / `ACTIVE` / `DRAINING` mode | Define mode ownership, values, observed time, freshness, and its effect on per-Registration Execution actual state |
| Execution actual state | `internal/control/model.go` defines only Issue Monitor, PR Monitor, and Forwarder supervised components | Add version-bound Execution actual state, observed/last-good/error/stale/recovery semantics; do not infer it only from `executionEnabled` |
| Queue actual state and recovery | Current projection has `queueDepth` and one `activeJobId`, but no Queue desired/actual/freshness/recovery or active job status/version | Define Queue projection, active job state and Registration version, last-good, stale, and recovery |
| Complete last-good / recovery | `lastHealthyAt` exists only for the three monitor components; last delivery, queue, job, and mode lack a uniform last-good/recovery contract | Reconcile all five component categories and the global source into a consistent truth model |
| Create capability coverage | Registration create operation exists, but `evidence/ciso-03/design-capability-trace.json` binds only the two baseline capabilities | Add capability-to-API/system/AC facet coverage and complete response/error semantics |
| Update capability coverage and transport outcome | Version-bound update exists, but it has no Designflow capability binding and no explicit command identity for outcome-unknown retry | Define duplicate-safe transport semantics, structured conflict/current-version response, audit, and authoritative verification |
| Disable capability coverage and work outcome | Disable exists, but its capability trace and old queued/leased work projection are absent | Define version/idempotency semantics and observable rejected/recovery outcomes after disable |
| Delivery inspection split | Current trace folds delivery read and retry into one command capability | Bind independent read semantics for delivery/attempt inspection and command semantics for retry |
| Stable anomaly-first pagination | Implementation uses an encoded numeric offset over a newly built anomaly-sorted projection | Bind continuation to a stable snapshot lineage or define equivalent no-duplicate/no-omission behavior |
| Structured browser-consumable errors | Several OpenAPI error responses are descriptions without response schemas; create/update/disable success content is also underspecified | Provide strict, bounded, non-secret error/result shapes for rejected, conflict, disconnected, outcome unknown, and persisted version |
| Design gate lineage | `internal/designgate` is compiled to the approved `design-revision-001` digest and the CISO-03 two-capability coverage | Keep fail-closed behavior; a new human-approved CISO-05 digest and complete #13 reconciliation must precede implementation use |

Until these gaps are resolved, the Experience Contract and Capability Requirements intentionally retain non-empty `ambiguities`. This revision must not be approved or consumed as an implementation gate merely because its schemas and digests are internally valid.

## Accessibility and responsive behavior

- WCAG 2.2 AA target.
- Native button, search, checkbox, details, dialog, heading, list, table/definition semantics.
- Enter/Space card selection; Escape/Cancel closes a dialog and returns focus; focus is trapped while a dialog is open.
- Selection, query, command, conflict, rejection, disconnect, and recovery use visible live status. Blocking failures are assertive once; routine updates are polite.
- Validation/rejection moves focus to the dialog error summary and preserves fields.
- Status never relies on color alone.
- At 320–767px the page becomes one column and the desired/actual matrix becomes labeled component groups without page-level horizontal scrolling.
- Pointer targets are at least 44px where actions are primary; focus ring is 3px; reduced-motion stops shimmer and state transitions.

## Canonical digest record

Digest rules are the pinned `contract-v1.0.0-rc.1` RFC 8785 rules: JSON and `+json` artifacts are canonicalized before SHA-256; HTML uses raw bytes; bundle digest removes only top-level `bundleDigest`.

| Item | Digest |
| --- | --- |
| Design Request `sourceRef.digest` / canonical Source Issue snapshot | `sha256:3293a23b56229c7c135eb9199bb0927ad46f0c6d22793ad326c9c554966b6d99` |
| Design Request `sourceDigest` | `sha256:77629d9a1031fd7b7a26f6fe21b00f41e60d7bcb4247b5a5e7cc6fdb964f1099` |
| `experience-contract.json` | `sha256:5d9c832d8d3fb929368e4d6597e1c75a552b1914ec37bcaba9d31f5e819bc573` |
| `design-system-delta.json` | `sha256:3257e579d77b739c1c67ff27fad774ebd869be944f22e00d878be2be05b19749` |
| `design-tokens.json` | `sha256:e24a64c7294d3b519d97c31db479060d8bbe30b08281bc7b07f91620a804406d` |
| `capability-requirements.json` | `sha256:ec17b7cf746d4a60b1036c6487fbea2cb2317c903969d8493e400316694a7cca` |
| `preview.html` raw bytes | `sha256:f7fdc337508c51df13c794f4e636f0008027ee659005877358658820f893d1f9` |
| Bundle digest (manifest without `bundleDigest`) | `sha256:56eb4d7283d6f1e2dd72cc931c48af2cee98c88103fc1709a106dd192725ba95` |
| Full canonical manifest file (audit only; not a contract field) | `sha256:d21b7f995361da3b103bf0527c5b052372ed53956d7849329c099279ebb70f8b` |

The schema-valid `design-request.json` is bound through `sourceRef.digest` to the RFC 8785 canonical JSON snapshot of `source-issue-15.json`: `sha256:3293a23b56229c7c135eb9199bb0927ad46f0c6d22793ad326c9c554966b6d99`. The raw file-with-trailing-newline checksum `sha256:b5dc9271913fb2b303ce86a2c0a873984df0b249b52a79e1bde70bfd7c627d12` is audit-only and is not the contract `sourceRef.digest`; the full canonical Design Request `sourceDigest` remains the separate value shown above.

## Validation record

Validation was run from the consumer repository without modifying implementation, tests, contracts, docs, GitHub, or external systems.

### Schema and cross-artifact validation — PASS

- Loaded all pinned `contracts/v1/*.schema.json` from `/Users/yu/Company/Development/designflow`.
- Validated `design-request.json`, `experience-contract.json`, `design-system-delta.json`, `capability-requirements.json`, and `design-bundle-manifest.json` with JSON Schema 2020-12 and formats enabled.
- Verified unique and valid Requirement → Purpose → Task → Flow Step → Capability, Region → Element, design-system, and attention-hierarchy references.
- Verified all 5 tasks have flows and Effort Budgets.
- Verified all 6 regions and 29 elements appear in the Attention Hierarchy.
- Verified all 7 capabilities are referenced by interactions.
- Verified request/revision/previous-revision lineage.
- Verified non-empty experience/capability ambiguities and absence of a Human Design Decision.
- Verified capability prose contains no invented HTTP method/path contract.

### RFC 8785 and content integrity — PASS

- Recomputed the Design Request source digest.
- Recomputed all five manifest artifact digests.
- Recomputed the Design Token document digest and matched the Design System Delta.
- Recomputed the bundle digest after removing only top-level `bundleDigest`.
- Parsed every JSON artifact with duplicate-free JSON input.

### Headless functional preview — PASS

Headless Google Chrome and the DevTools protocol exercised the saved `preview.html`:

- Loading, empty, stale, disconnected, rejected, conflict, and verified-success fixtures.
- Repository filter and live result announcement.
- Create dialog initial focus, strict unsafe identity rejection, visible error summary, and error focus.
- Valid static mutation simulation and separation of accepted/pending from verified success.
- Dialog Cancel focus return.
- Exact 360px viewport with no page-level horizontal overflow and the component matrix converted to labeled stacked rows.
- Accessibility tree exposure for dialog, button, heading, and status roles.
- No runtime exception or console error.
- No external resource request; CSP sets `connect-src 'none'` for the static review fixture.

Residual verification: this static proposal does not prove a future real Control API session, Origin/CSRF behavior, persistence, or device/vendor boundary. Those remain implementation and #13 reconciliation tests after human approval.
