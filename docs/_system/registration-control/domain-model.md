# Registration Control Domain Model

- **DOM-registration-control-001 Desired Registration** — repository identity、enabled、
  Issue/PR monitor、execution switch、単調増加 version の operator intent。
- **DOM-registration-control-002 Actual Component State** — Registration version に束縛された
  `starting|running|stopped|failed|disconnected` の観測。version 不一致、観測欠落、期限超過は healthy ではなく
  unknown/stale として射影する。
- **DOM-registration-control-003 Supervised Component** — Issue monitor、PR monitor、forwarder の
  `(registration_id, component, registration_version)` identity。desired false または DB 不達で停止する。
- **DOM-registration-control-004 Convergent Work Item** — repository、entity kind、number、GitHub
  `updated_at` で表す logical work。Webhook delivery key と poll cursor は異なる transport identity だが、
  logical idempotency identity は共有する。
- **DOM-registration-control-005 Delivery Attempt** — durable delivery claim と自動 backoff/manual retry の履歴。
  ownership expiry 後も delivery と route attempt は失われない。
- **DOM-registration-control-006 Approved Design Lineage** — provider tag/commit、request、
  revision、bundle digest、human decision、capability coverage の不可分な組。異 revision の混在や ambiguity は
  Control API contract の入力になれない。
- **DOM-registration-control-007 Five-component status** — Issue Monitor、PR Monitor、Forwarder、
  Execution、Queueを別componentとして扱い、それぞれdesired、actual、observedAt、freshness、stale reason、
  last-good、last error、recoveryを持つ。Queueはdurable depthとactive leased job identity/state/versionを併記する。
- **DOM-registration-control-008 Operator session** — one-time bootstrap、opaque server-side session、
  HttpOnly cookie、session-bound CSRF proof、expiry/logoutを一つのsame-origin security aggregateとして扱う。
- **DOM-registration-control-009 Fenced command** — create/update/disable/retryのnormalized request、
  bounded idempotency key、resource identity、observed/current Registration version（retryはroute attemptも）、
  immutable outcomeを同じtransactional identityへ束縛する。

不変条件: disabled/unknown/stale Registration から job を作らない、persist-before-ack、repository ごとの active job は
高々1件、actual state を desired state と取り違えない、MONITOR_ONLYからjobをclaimしない、
PostgreSQL 以外へ control state を dual-write しない。
