# Control Store Domain Model

- **DOM-control-store-001 Registration** — repository desired stateと単調増加version。
- **DOM-control-store-002 Delivery** — transport receiptとconsumer別完了状態。
- **DOM-control-store-003 Job** — version付きenvelope、source、idempotency identity、queue status。
- **DOM-control-store-004 Lease / Attempt** — 時限worker所有権と、reclaim後も失われない実行履歴。
- **DOM-control-store-005 Released Build / Defect** — issue/PR revision/head SHAとreview oracleまたはrelease escapeの1:N link。
- **DOM-control-store-006 Artifact Link** — artifact本体でなくURI/digest/size/timeだけを指すmetadata。
- **DOM-control-store-007 Runner Job Contract** — repository/event/ref/gate identityだけを持つversioned executable envelope。
- **DOM-control-store-008 Execution Guard** — lease/Registrationの現在値をcritical boundaryごとに裁定するtransactional verdict。
- **DOM-control-store-009 Side-effect Permit** — DB guard成功後、対応するpush/merge/releaseの1回だけ消費できる短命capability。

不変条件: active jobはrepositoryごとに高々1件、active leaseはjobごとに高々1件、stale/disabled Registrationのjobは
claimしない。artifactはRegistration rootからreal pathで逸脱できず、lease loss後にside effect permitを消費できない。
根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)、
[ADR-0015](../../decisions/ADR-0015-postgresql-fenced-isolated-runner.md)
