# Webhook コンテキスト — ドメインモデル

- **DOM-webhook-001 delivery idempotence不変条件** — 同じ`LANG-webhook-003`は高々1つのInbox recordと高々1回のconsumer効果を持つ。再送は既存結果を返す（ADR-0010）。
- **DOM-webhook-002 registered repository不変条件** — enabledな`LANG-webhook-004`だけがrouting対象。未登録repo・未許可eventは理由付きignoredで、consumerを起動しない。
- **DOM-webhook-003 persist-before-ack不変条件** — 検証済みEnvelopeを`LANG-webhook-002`へ保存できた後だけ2xxを返す。parse/検証/保存失敗を成功応答で隠さない。
- **DOM-webhook-004 trigger-not-truth不変条件** — Webhook payloadだけでmerge/release/claimを確定しない。consumerはcurrent GitHub snapshotを再取得し、store stateと突合する。
- **DOM-webhook-005 consumer safety不変条件** — registrationは列挙済みconsumer adapterだけを選べる。GUIやpayloadから任意shell commandを保存・実行しない。
