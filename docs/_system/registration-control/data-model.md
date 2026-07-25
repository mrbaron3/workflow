# Registration Control Data Model

- **DATA-registration-control-001 Registration input/output** — `repository_registrations` の
  desired switches、empty-only configuration、version、timestamps。create idempotency と `If-Match` update を持つ。
- **DATA-registration-control-002 Actual state** — `monitor_actual_states` の
  `(registration_id, component)`、registration version、state、supervisor、observed/healthy/error。
- **DATA-registration-control-003 Delivery routing** — `webhook_deliveries` の global delivery key、
  repository/event/payload、registration/version binding、processing token/expiry、route attempts、retry time。
- **DATA-registration-control-004 API idempotency** — `control_api_requests` の
  `(scope, idempotency_key)`、request SHA-256、status、response、actor、created time。
- **DATA-registration-control-005 Retry evidence** — `delivery_retry_attempts` の delivery、
  idempotency key、observed attempts、actor、accepted/rejected state、reason。
- **DATA-registration-control-006 Monitor convergence** — `monitor_cursors` と `jobs` が
  GitHub observation と logical idempotency identity を保持し、webhook/poll の重複を DB unique 制約で収束させる。
- **DATA-registration-control-007 Experience evidence** — pinned provider bundle、
  `PROVENANCE.json`、Capability-to-API/system/AC trace。runtime mutable stateではなく、build input と監査証跡である。

Durable control-plane 配置はすべて `agentops_control` schema に限定する。evaluation-domain
`.harness/db.json` は変更・複製せず、旧 TypeScript webhook model は非永続 compatibility oracle のままにする。
