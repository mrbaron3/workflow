# Control Store Architecture

- **ARCH-control-store-001 PostgreSQL SoT** — CISO control-planeのdurable stateは`agentops_control`だけへ書く。
  evaluation domainのJSON storeとはentity境界を共有しない（ADR-0013）。
- **ARCH-control-store-002 Version Gate** — consumer/runnerは接続後、既知の連番version/name/checksumが完全一致するまで
  起動しない。migrationとverifyは同じadvisory lockで直列化し、migrationは単一transactionでのみ進める。
- **ARCH-control-store-003 Transactional Repositories** — Registration、cursor、delivery/consumer、job、lease/attempt、
  audit、artifact metadata、build defectを同じDB transaction境界で操作する。
- **ARCH-control-store-004 Durable Queue** — idempotency/source unique制約とrepository partial unique indexをDB権威とし、
  runtime rejectionを補助に置く。
- **ARCH-control-store-005 Lease Competition** — workerは`FOR UPDATE SKIP LOCKED`で1 jobだけをclaimし、heartbeat/expiry/
  reclaimをattempt historyと原子的に更新する。webhook routingもtoken＋expiry＋heartbeatでlive ownerとcrashを区別する。
- **ARCH-control-store-006 Wake + Reconcile** — LISTEN/NOTIFYはhint、周期queryは真実回収経路である。
- **ARCH-control-store-007 Published Contract** — SQL migrationとv1 JSON Schema/fixtureがTypeScript/Go間のPublished
  Languageである。

根拠: [ADR-0013](../../decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)
