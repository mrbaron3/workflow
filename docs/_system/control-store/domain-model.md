# Control Store Domain Model

- **DOM-control-store-001 Registration** — repository desired stateと単調増加version。
- **DOM-control-store-002 Delivery** — transport receiptとconsumer別完了状態。
- **DOM-control-store-003 Job** — version付きenvelope、source、idempotency identity、queue status。
- **DOM-control-store-004 Lease / Attempt** — 時限worker所有権と、reclaim後も失われない実行履歴。
- **DOM-control-store-005 Released Build / Defect** — issue/PR revision/head SHAとreview oracleまたはrelease escapeの1:N link。
- **DOM-control-store-006 Artifact Link** — artifact本体でなくURI/digest/size/timeだけを指すmetadata。

不変条件: active jobはrepositoryごとに高々1件、active leaseはjobごとに高々1件、stale/disabled Registrationのjobは
claimしない。根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)
