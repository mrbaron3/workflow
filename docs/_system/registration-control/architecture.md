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
- **ARCH-registration-control-009 Loopback operator session boundary** — dashboard bootstrap は configured
  IPv4 loopback origin の exact Host と loopback peer だけで一回限りの token を constant-time 検証し、asset 読込前に
  clean URL へ 303 redirect する。server-side session ID は HttpOnly / SameSite=Strict / path `/` / expiring
  cookie にだけ置き、browser code、DOM、URL、storage、payloadへ bearer secret を渡さない。container targetは
  host-loopbackへpublishする同一process proxyから`127.0.0.1` backendへだけ転送し、forwarding provenance
  headerを除去するため、app側bootstrap peer条件とcontainer host boundaryを同時に維持する。logout/expiry時は
  server logへ新しい一回限りbootstrap URLを発行し、失効済みtoken/sessionを再利用しない。
- **ARCH-registration-control-010 Exact Origin + CSRF boundary** — browser の unsafe request は canonical
  Origin の byte-exact 一致、`Sec-Fetch-Site: same-origin`、session-bound `X-CSRF-Token` の全てを要求する。
  CSRF proof は session 確立時に生成して memory だけに保持し、logout/expiry で失効する。CSP、no-store、
  no-referrer、nosniff、frame denial を全 response に適用し、CORS は開かない。
- **ARCH-registration-control-011 Authoritative five-component truth** — `GET /v1/registrations` は
  `MONITOR_ONLY|ACTIVE` mode と Issue Monitor、PR Monitor、Forwarder、Execution、Queue の desired / actual /
  observedAt / freshness / staleReason / lastGoodAt / lastError / recoveryState を Registration version-bound
  repeatable-read snapshot から返す。MONITOR_ONLY は monitor observation を継続するが enqueue/lease/execution を
  fail-closed で阻止し、DB/API 切断を cached success に置換しない。
- **ARCH-registration-control-012 Strict command envelope** — create/update/disable/retry は allowlisted
  repository identity と boolean flag、明示した fence 以外を strict JSON decoder で拒否する。arbitrary command、
  host path、image、mount、credential、environment、provider endpoint は API schema と runner payload の双方に
  存在せず、idempotency key も bounded allowlist format に限定する。
- **ARCH-registration-control-013 Duplicate-safe outcome + version fence** — create/update/disable/retry は
  request hash と response を PostgreSQL transaction に保存し、applied/duplicate の structured outcome、
  command identity digest、observed/current Registration fence、recordedAt、cancellable=false を返す。
  disable は version を一度だけ進め、旧versionの queued jobをtransactionalにrejectし、leased workも既存の
  pre-side-effect fenceにより再活性化できない。UIはauthoritative re-query一致後だけverified successをannounceする。
- **ARCH-registration-control-014 Delivery retry registration fence** — retry body は observed route attempts に加え
  expected Registration identity/version を必須とし、delivery binding、current Registration enabled/version、
  retryable state を同じrow-lock transactionで照合する。accepted/rejected outcome、attempt、audit、idempotent
  replayをdurableに保存し、unknown/disabled/stale/mismatched fenceはjobやretryを作らず理由付き409にする。

公開契約は [`contracts/control-api/v1/openapi.yaml`](../../../contracts/control-api/v1/openapi.yaml)、
Capability trace は [`evidence/ciso-03/design-capability-trace.json`](../../../evidence/ciso-03/design-capability-trace.json)
と revision-02 の
[`capability-reconciliation.json`](../../../evidence/ciso-05/design/revision-02/capability-reconciliation.json)。
根拠: ADR-0010、ADR-0013、ADR-0014。
