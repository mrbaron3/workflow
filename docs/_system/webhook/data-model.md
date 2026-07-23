# Webhook コンテキスト — データモデル

- **DATA-webhook-001 `WebhookDelivery`** — `{id, deliveryKey, repository, event, action, headers, payload, status, attempts, lastError, receivedAt, updatedAt}`。`deliveryKey`一意、status=`pending|processing|processed|ignored|failed`。
- **DATA-webhook-002 `WebhookReceipt`** — ingress応答用の`{deliveryId, duplicate, status}`。duplicateでも既存identityを返し、新recordを作らない。
- **DATA-webhook-003 `WebhookRepositoryRegistration`** — `{id, repository, enabled, events[], consumers[], workspaceRoot|null, readyLabel|null, baseBranch|null, createdAt, updatedAt}`。`repository`一意。
- **DATA-webhook-004 `ForwarderHealth`** — registrationごとの揮発状態`stopped|starting|running|backoff|failed`とlastError/lastStartedAt。SoTではなくGUI観測用で、resumeはRegistrationから再構成する。
- **DATA-webhook-005 永続配置** — 初期実装は`.harness/webhooks.json`を専用JSON storeとして用い、atomic renameで保存する。長期daemonとEval DBの同時writeを衝突させない。将来SQLite等へ差替えてもPublished Languageは不変。
