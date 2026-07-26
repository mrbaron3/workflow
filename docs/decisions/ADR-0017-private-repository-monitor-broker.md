# ADR-0017: private repository monitor readをtyped durable brokerへ閉じる

- 状態: 採択・実装済み（CISO-07）
- 親: #10／所有 Issue: #17／所有 AC: AC-CISO-012
- 関連: [ADR-0014](ADR-0014-registration-driven-go-control.md)、
  [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md)、
  [ADR-0016](ADR-0016-agentopsctl-lifecycle-authority.md)

## 文脈

統合対象`mrbaron3/workflow`はprivate repositoryであり、credentialを持たないGo controlからの匿名Issue/PR pollは
GitHubの404でfail closedした。一方、controlへrunnerと同じGitHub credentialを渡すとrole separationを失い、
任意URLをrunnerへ中継するproxyを置くとcredential-bearing境界を不必要に拡大する。

## 決定

1. PostgreSQL schema version 5へ`monitor_broker_requests`を追加する。requestはRegistration ID/version、
   repository、`issue|pull_request`、`updatedAfter` cursorだけを持ち、active cursor単位でdurable dedupする。
2. Go controlは`mrbaron3/workflow`だけに固定された`BrokeredGitHubSource`を使う。任意URL、HTTP method、
   query、header、provider response本文をrequestに持たせない。
3. credential-bearing runnerは`FOR UPDATE SKIP LOCKED`でrequestをleaseし、固定した`gh api` endpointから
   number/updatedAt/kindだけを抽出する。repository、kind、page count、item count、byte size、timestamp schemaを
   検証してからresponseを保存する。provider readは全体deadline、10 page、1000 item、8 MiB raw responseで
   fail closedとし、任意URL、`--paginate`、`jq`へ委譲しない。
4. claim時にRegistration version/enabledとmonitor switchを再検証する。stale/disabled/out-of-allowlist requestは
   provider call前にfailedへ閉じ、deny auditを残す。lease expiry後は別workerが回収でき、旧leaseのcomplete/failは
   ともに拒否する。broker DB障害はexecution serviceを停止せず、未保存failureはlease expiryで回収する。
5. responseは最大256 KiB、1000 itemsとし、auditにはitem countとcanonical response SHA-256だけを残す。
   GitHub credential、credential fingerprint、provider response本文、汎用transport情報は保存しない。
6. MONITOR_ONLYでもrunner processはbrokerだけを処理するが、既存serviceのoperating-mode fenceにより
   AgentOps job lease/executionは行わない。ACTIVEだけが既存runner executionへ進む。
7. version 5 migrationは単一transactionのadditive migrationであり、commit前のfailureはversion 4を保持する。
   commit後のrollbackはvolumeとbroker/audit行を保存したsafe modeへのcompensation＋version 5 imageによる
   forward recoveryである。version 4 consumerはunknown schemaをfail closedし、durable broker証跡を失う
   destructive down migrationは提供しない。

## 帰結

- controlは引き続きGitHub credentialを持たず、private repositoryのIssue/PR monitorを同時に収束できる。
- PostgreSQLはrequest、lease、failure、digest auditの唯一のdurable SoTであり、restart後もpending/expired workを回収する。
- PostgreSQL containerは起動時image digest＋credential-redacted canonical specへsealされ、credential値はactualと
  process内だけで比較する。admin credential rotationはDRAINING・zero workでtransactionalに旧credential失効を
  検証してからvolume-preserving restartする。
- GitHub webhook forwardingの汎用proxyではない。webhook ingressは既存の署名検証・delivery dedup境界を使う。
- 匿名pollがprivate repositoryで404になった初回失敗は証跡から消さず、broker cutoverの理由として残す。

## 実装先 id

- architecture: `ARCH-control-store-016`、`ARCH-container-runtime-015`
- domain-model: `DOM-control-store-013`、`DOM-container-runtime-013`
- data-model: `DATA-control-store-017`、`DATA-container-runtime-008`
- ubiquitous-language: `LANG-control-store-020`〜`022`、`LANG-container-runtime-016`〜`017`
