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
- **LANG-control-store-011 Runner Job** — shell commandでなく、version付きrepository/event/ref/gate identity。
- **LANG-control-store-012 Critical Boundary** — claim/provider/push/merge/releaseの副作用直前の再認可点。
- **LANG-control-store-013 Execution Guard** — lease ownership/expiryとRegistration current stateをDBで裁定する操作。
- **LANG-control-store-014 Side-effect Permit** — guard成功から対応side effectまでを結ぶ短命・単回token。
- **LANG-control-store-015 Runner Failure** — code/retryable/boundary/timeを持つversioned failure。
- **LANG-control-store-016 Lifecycle State** — operatorが明示したOFF／MONITOR_ONLY／ACTIVE／DRAININGの永続運転状態。
- **LANG-control-store-017 Lifecycle Transition** — validation、idempotency、actor、時刻、結果を一体で保存する状態変更。
- **LANG-control-store-018 Drain Fence** — DRAINING後の新規routing/enqueue/leaseをDBで拒否する競合境界。
- **LANG-control-store-019 Recovery Reconciliation** — persisted mode/lease/attemptとactual topologyをrestart時に照合する操作。
- **LANG-control-store-020 Monitor Broker Request** — 固定repository/kind/cursorだけを持つprivate monitorのdurable read要求。
- **LANG-control-store-021 Monitor Broker Lease** — runnerが1 requestを期限付きで処理する所有権。expiry後は回収される。
- **LANG-control-store-022 Sanitized Monitor Response** — repository/kind/number/updatedAtとnext cursorだけのbounded応答。

根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)、
[ADR-0015](../../decisions/ADR-0015-postgresql-fenced-isolated-runner.md)、
[ADR-0017](../../decisions/ADR-0017-private-repository-monitor-broker.md)
