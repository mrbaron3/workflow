# ADR-0013: control-plane durable stateはPostgreSQLだけを正本とする

- 状態: 採択・吸収・構造実装済み（CISO-02）
- 親: #10／所有Issue: #12／所有AC: AC-CISO-003, AC-CISO-004, AC-CISO-005
- supersedes: [ADR-0001](ADR-0001-json-store-as-source-of-truth.md) のうち control-plane entity
  （evaluation domain の Issue Contract／EvalRun／review evidence は supersede しない）

## 文脈

Repository Registration、monitor cursor、webhook delivery/consumer、job、lease、attempt、runtime audit は
複数process/containerから競合更新され、crash後も復旧する必要がある。JSONのatomic renameは単一processの受信箱には
使えても、transaction、行lock、DB制約、lease expiry、wake通知を共有できない。大きなclone/worktree/test outputを
DBへ入れるとcontrol transactionとartifact lifecycleが結合する。一方、#18のreview-time oracle mismatchと#21が指摘する
post-release escapeはreleased buildとの永続linkがなければ較正信号を再計算できない。

## 決定

1. `agentops_control` schemaをcontrol-plane durable stateの唯一のSoTとする。CISO-02の
   `PostgresControlStore`はJSONへfallback/dual-writeしない。旧webhook daemonは挙動oracleとしてソースに残るが、
   PostgreSQL control deploymentと同時に起動せず、後続control cutoverで廃止する。
2. SQL migrationは`db/control-store/migrations/`の連番・checksum付きファイルを正本にする。全pending migrationを
   advisory lock下の1 transactionで適用し、partial/unknown/checksum mismatch/接続失敗はconsumer/runner起動前に
   fail closedとする。verifyも同じadvisory lockでmigrationとの競合後に再検証する。通常起動はverify-only、
   明示したmigration commandだけがDDLを変更する。
3. webhook delivery key、job idempotency key、source keyをuniqueにし、repositoryごとの
   `queued|leased` jobはpartial unique indexで高々1件とする。runtimeも先にactive jobを検査して理解可能な拒否を返すが、
   最終権威はDB制約である。registration version変更時は未取得jobを同じtransactionでrejectし、古いjobが
   single-flight枠を占有し続けない。
4. lease acquisitionはtransaction内の`FOR UPDATE OF job, registration SKIP LOCKED`で行う。heartbeat、expiry、reclaimを
   lease/attempt historyへ記録し、有効な同一registration versionのexpired jobだけを再queueする。webhook routingも
   ownership token、expiry、heartbeatを持ち、expired ownershipだけをrestart recoveryする。永続headerは
   case-insensitive allowlistでcredential/signatureを除外する。process restartはDBから同じqueueを再構成する。
5. `LISTEN/NOTIFY`は低latency wakeにだけ使う。`listReconciliationWork`を周期的な真実回収経路として必ず残す。
6. artifactはURI、SHA-256、size、createdAtだけを保持する。released buildと`review_oracle|release_escape` defectを
   1:Nで結び、panel approveかつgate returnまたはescapeのbuildを導出可能にする。
7. TypeScriptと将来のGoは同じSQL migrationと`contracts/control-store/v1/`のJSON Schema/fixtureを消費する。
   monitor supervision、provider execution、Dashboard、Mac lifecycle CLIはこの境界に含めない。

## 帰結

- enqueue/lease/single-flightは複数process間でもDB transactionと制約で直列化される。
- PostgreSQLが利用不能、migration途中、schemaが未知なら処理を開始できない。可用性より誤った実行防止を優先する。
- notificationを失ってもperiodic reconciliationで収束する。
- evaluation domainの`.harness/db.json`はこのADRの対象外であり、同データをPostgreSQLへ複製しない。
- Apple Containerのnamed ext4 volumeは`lost+found`を持つため、volumeを`/var/lib/postgresql`へmountし、
  `PGDATA=/var/lib/postgresql/data`を使う。これはDocker/Podmanでも同じOCI契約で動く。

## 実装先 id

- architecture: `ARCH-control-store-001`〜`007`
- domain-model: `DOM-control-store-001`〜`006`
- data-model: `DATA-control-store-001`〜`009`
- ubiquitous-language: `LANG-control-store-001`〜`010`
