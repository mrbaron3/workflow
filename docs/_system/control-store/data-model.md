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

根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)
