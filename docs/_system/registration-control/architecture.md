# Registration Control Architecture

- **ARCH-registration-control-001 Control API status projection** — `GET /v1/registrations` は
  PostgreSQL の Registration、component actual state、monitor cursor、delivery、active job を同一
  repeatable-read snapshot から任意repository filter付きでanomaly-first に射影する。DB 不達時に cache を
  healthy として返さず、503へ最終正常取得時刻とbounded-retry hintだけを含める。
- **ARCH-registration-control-002 Registration supervisor** — Go `agentops-control` は enabled な
  Registration の version ごとに Issue monitor、PR monitor、local forwarder を動的に起動・停止・再起動する。
  desired state は毎回 PostgreSQL から再構成し、process 内 registry を正本にしない。
- **ARCH-registration-control-003 DB fail-closed boundary** — schema/checksum 不一致または起動時 DB 不達では
  HTTP server、monitor、routerを開始しない。稼働中の Registration reconciliation が失敗した場合は全 component を
  停止し、status query は 503 にする。
- **ARCH-registration-control-004 Retry idempotency** — Registration create と delivery retry は
  `Idempotency-Key`、request hash、response を PostgreSQL transaction に保存する。key の異なる request への再利用、
  stale observed-attempt、processing/processed delivery を 409 で拒否する。受理時点の `pending` 応答を固定的な
  現在状態として扱わず、`GET /v1/deliveries/{deliveryId}` がdeliveryとretry attemptの最新durable stateを返す。
- **ARCH-registration-control-005 Durable delivery router** — HMAC と repository identity を検証した delivery は
  commit 成功後だけ 202 ACK する。router は `FOR UPDATE SKIP LOCKED` と期限付き ownership で claim し、
  unknown/disabled/stale/capability-disabled/execution-disabled を理由付き ignored にして job を作らない。
  Webhook と poll は同じ `WorkItem.IdempotencyKey` へ収束する。
- **ARCH-registration-control-006 Transactional runtime audit** — Registration command、job enqueue、
  delivery outcome、manual retry は対象 state mutation と同じ transaction で `runtime_audit` へ記録する。
- **ARCH-registration-control-007 Experience design gate** — Control API 起動前に
  `mrbaron3/designflow@contract-v1.0.0-rc.1` の pinned bundle を検証し、human-approved decision と
  `revisionId` / `bundleDigest` の一致、capability 完全性、ambiguity 不在、API/system/Issue AC coverage を要求する。
  self-consistentな差替えもcompiled trust anchorのexact bundleDigest不一致として拒否し、unapproved、
  digest mismatch、mixed revision、incomplete capability、coverage 欠落は fail closed にする。
- **ARCH-registration-control-008 Wake + truth recovery** — Registration と webhook の `LISTEN/NOTIFY` は
  low-latency wake にだけ使う。切断時は再接続し、失われた通知は supervisor/router の周期 reconciliation が
  PostgreSQL から回収する。

公開契約は [`contracts/control-api/v1/openapi.yaml`](../../../contracts/control-api/v1/openapi.yaml)、
Capability trace は
[`evidence/ciso-03/design-capability-trace.json`](../../../evidence/ciso-03/design-capability-trace.json)。
根拠: ADR-0010、ADR-0013、ADR-0014。
