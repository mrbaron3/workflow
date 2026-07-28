# Webhook コンテキスト — データモデル

- **DATA-webhook-001 `WebhookDelivery`** — `{id, deliveryKey, repository, event, action, headers, payload, status, attempts, lastError, receivedAt, updatedAt}`。`deliveryKey`一意、status=`pending|processing|processed|ignored|failed`。
- **DATA-webhook-002 `WebhookReceipt`** — ingress応答用の`{deliveryId, duplicate, status}`。duplicateでも既存identityを返し、新recordを作らない。
- **DATA-webhook-003 `WebhookRepositoryRegistration`** — `{id, repository, enabled, events[], consumers[], workspaceRoot|null, readyLabel|null, baseBranch|null, createdAt, updatedAt}`。`repository`一意。
- **DATA-webhook-004 `ForwarderHealth`** — registrationごとの揮発状態`stopped|starting|running|backoff|failed`とlastError/lastStartedAt。SoTではなくGUI観測用で、resumeはRegistrationから再構成する。
- **DATA-webhook-005 永続配置（superseded）** — 初期JSON inboxはADR-0013/CISO-02で廃止した。現行の
  `WebhookControlStore`はrouting unit test用の非durable compatibility modelだけであり、production entry pointは
  fail closedする。Delivery/Registrationの唯一のdurable配置は`agentops_control` schema（DATA-control-store-001/003）。
- **DATA-webhook-006 Registration binding / retry** — deliveryはrouting時の`registration_id`と
  `registration_version`、期限付きprocessing token、`next_retry_at`、route attemptを保持する。manual retry履歴は
  `delivery_retry_attempts`へ分離し、同じdelivery/idempotency keyを一意にする。
