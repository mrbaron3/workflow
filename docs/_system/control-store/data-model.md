# Control Store Data Model

- **DATA-control-store-001** `repository_registrations` — canonical repository、desired switches、version。
- **DATA-control-store-002** `monitor_cursors` — Registration/monitor kindごとの単調な最後の観測点。
- **DATA-control-store-003** `webhook_deliveries` / `webhook_consumers` — receipt dedup、allowlist済みheader、
  consumer state、pending claim、routing ownership token/expiry。
- **DATA-control-store-004** `jobs` — v1 envelope、registration-scoped source/idempotency unique、repository active
  partial unique。
- **DATA-control-store-005** `job_leases` / `job_attempts` — active token、heartbeat/expiry、再試行履歴。
- **DATA-control-store-006** `runtime_audit` — actor/event/entityへのappend-only監査。
- **DATA-control-store-007** `artifact_links` — URI、SHA-256、size、createdAtだけ。
- **DATA-control-store-008** `released_builds` / `build_defects` — panel/gate/build identityと、個別照会可能な複数
  escape/oracle mismatch。
- **DATA-control-store-009** `schema_migrations` — version、filename、SHA-256 checksum。
- **DATA-control-store-010** `monitor_actual_states` — Registration version付きcomponent actual state、
  supervisor、observed/healthy/error。
- **DATA-control-store-011** `control_api_requests` / `delivery_retry_attempts` — command idempotency、
  request hash/response、operator retry attempt。
- **DATA-control-store-012** runner job `payload` / `result` / `failure` — strict version 1 JSON contract。
- **DATA-control-store-013** runner attempt `failure` — retry/restart後も残るtyped failureとboundary。
- **DATA-control-store-014** runner artifact/audit — Registration-scoped volume URI＋digest/size/time、および
  boundaryごとのallow/deny reason。artifact bytes、credential、test output本文はDBへ入れない。
- **DATA-control-store-015** `lifecycle_state` — singleton mode、generation、transition identity/time、
  drain deadline/timeout、redacted last error。
- **DATA-control-store-016** `lifecycle_transitions` — unique idempotency key、actor、from/to、applied/idempotent/rejected/
  compensated status、deadline、error、details、開始/完了時刻を持つ監査履歴。
- **DATA-control-store-017** `monitor_broker_requests` — Registration/version、固定repository、issue/PR kind、
  strict cursor/digest、pending/leased/succeeded/failed state、worker/lease expiry、sanitized responseまたはbounded error。
  active cursorのpartial unique indexとclaim order indexを持ち、credential/provider本文は保存しない。

根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)、
[ADR-0015](../../decisions/ADR-0015-postgresql-fenced-isolated-runner.md)、
[ADR-0017](../../decisions/ADR-0017-private-repository-monitor-broker.md)
