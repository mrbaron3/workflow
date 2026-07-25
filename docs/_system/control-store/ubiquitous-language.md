# Control Store Ubiquitous Language

- **LANG-control-store-001 Registration** — repositoryのdesired control state。
- **LANG-control-store-002 Registration Version** — stale jobを拒否する単調増加revision。
- **LANG-control-store-003 Delivery Key** — provider webhook receiptの重複排除identity。
- **LANG-control-store-004 Idempotency Key** — webhook/pollを跨ぐ同一logical jobのidentity。
- **LANG-control-store-005 Active Job** — `queued`または`leased`のsingle-flight対象。
- **LANG-control-store-006 Lease** — expiry付きworker所有権。
- **LANG-control-store-007 Attempt** — reclaim後も残る1回の実行履歴。
- **LANG-control-store-008 Wake** — LISTEN/NOTIFYの非権威hint。
- **LANG-control-store-009 Reconciliation** — DBからdesired workを回収する周期query。
- **LANG-control-store-010 Escape** — panel approve済みreleased buildにrelease後紐づいたdefect。

根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)
