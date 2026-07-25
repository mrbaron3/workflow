# Webhook コンテキスト — ユビキタス言語

| ID | 用語 | 定義 |
| --- | --- | --- |
| LANG-webhook-001 | Delivery Envelope | providerのdelivery id、event、repository、headers、payload、受信時刻を保持する受信契約。 |
| LANG-webhook-002 | Durable Event Inbox | ACK前にDelivery Envelopeを耐久保存し、処理状態と再実行履歴を持つ受信箱。 |
| LANG-webhook-003 | Delivery Identity | `X-GitHub-Delivery`を正規keyとする再送同一性。欠落するlocal testではpayload hashを明示fallbackにする。 |
| LANG-webhook-004 | Repository Registration | `owner/name`とevents、consumer、workspace/store binding、enabled状態を対応付ける管理レコード。 |
| LANG-webhook-005 | Normalized GitHub Event | consumerが受け取るtransport非依存イベント。raw payloadを制御フローへ漏らさない。 |
| LANG-webhook-006 | Reconciliation Poll | Webhook未配送・順序逆転・停止中イベントをGitHub current snapshotから回収する周期照合。 |
| LANG-webhook-007 | Local Forwarder | registrationごとに`gh webhook forward`を監督しloopback ingressへ配送するruntime adapter。 |
