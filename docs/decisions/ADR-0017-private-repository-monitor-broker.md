# ADR-0017: private repository monitor／triageをtyped durable capabilityへ閉じる

- 状態: 採択・実装済み（CISO-07）
- 親: #10／所有 Issue: #17／所有 AC: AC-CISO-012
- 関連: [ADR-0014](ADR-0014-registration-driven-go-control.md)、
  [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md)、
  [ADR-0016](ADR-0016-agentopsctl-lifecycle-authority.md)

## 文脈

最初のdogfood対象`mrbaron3/workflow`はprivate repositoryであり、credentialを持たないGo controlからの匿名Issue/PR
pollはGitHubの404でfail closedした。一方、controlへdevelopment runnerと同じGitHub credentialを渡すとrole
separationを失い、
任意URLをrunnerへ中継するproxyを置くとcredential-bearing境界を不必要に拡大する。
さらに複数repositoryを常駐監視する段階では、監視credentialをworkspaceと開発権限を持つrunnerへ置くと、
Issue分類だけのためにclone／push／provider execution surfaceまで常時起動することになる。

## 決定

1. PostgreSQL schema version 5へ`monitor_broker_requests`を追加する。requestはRegistration ID/version、
   repository、`issue|pull_request`、`updatedAfter` cursorだけを持ち、active cursor単位でdurable dedupする。
2. Go controlは1〜64件のcanonical `owner/name` allowlistに限定された`BrokeredGitHubSource`を使う。
   repository名をbinaryへ固定せず、allowlistとcurrent Registrationの両方に一致する対象だけを扱う。
   任意URL、HTTP method、query、header、provider response本文をrequestに持たせない。
3. credential-bearing triage processは`FOR UPDATE SKIP LOCKED`でrequestをleaseし、固定したGitHub endpointから
   number/updatedAt/kindだけを抽出する。repository、kind、page count、item count、byte size、timestamp schemaを
   検証してからresponseを保存する。provider readは全体deadline、10 page、1000 item、8 MiB raw responseで
   fail closedとし、任意URL、`--paginate`、`jq`へ委譲しない。
4. claim時にRegistration version/enabledとmonitor switchを再検証する。stale/disabled/out-of-allowlist requestは
   provider call前にfailedへ閉じ、deny auditを残す。lease expiry後は別workerが回収でき、旧leaseのcomplete/failは
   ともに拒否する。broker DB障害はexecution serviceを停止せず、未保存failureはlease expiryで回収する。
5. responseは最大256 KiB、1000 itemsとし、auditにはitem countとcanonical response SHA-256だけを残す。
   GitHub credential、credential fingerprint、provider response本文、汎用transport情報は保存しない。
6. MONITOR_ONLYではtriage processだけがtriage専用GitHub credentialとGitHub broker egressでtyped brokerを
   処理する。AI provider credential・provider egressを持たず、Issue分類jobをclaimしない。development runnerは
   起動しない。ACTIVEではtriageへprovider credential/egressを追加し、別credential・workspace・DB roleを持つ
   development runnerを追加する。
7. 各migrationは単一transactionのadditive migrationであり、commit前のfailureは直前versionを保持する。
   commit後のrollbackはvolumeとbroker/audit行を保存したsafe modeへのcompensation＋current-schema imageによる
   forward recoveryである。旧schema consumerはunknown schemaをfail closedし、durable broker証跡を失う
   destructive down migrationは提供しない。
8. schema version 6ではbroker table直接`UPDATE`を廃止し、live lease token・worker・DB expiryを
   検証する`SECURITY DEFINER` claim/complete/fail capabilityだけを付与する。terminal stateはlease ownershipを
   必ず消去し、responseはrequestのrepository/kindに一致するstrict schemaだけを受ける。
9. schema version 7で`agentops_triage` DB roleを追加し、monitor capabilityをdevelopment用`agentops_runner`から
   revokeする。Issue observationはshell commandやclone URLを含まないidentity-only `agentops.triage` jobへ入り、
   PR observationは従来のdevelopment reconciliationへ入る。generic lease実装が共有するjobs／attempts／leasesは
   PostgreSQL RLSでjob typeを再強制し、triage roleはtriage job、runner roleはdevelopment job以外を不可視にする。
10. triageはIssue、bounded comments、設定したrepository context文書、open Issue titleだけをreadし、strict
    structured decisionから管理対象の3ラベルとmarker付きcommentだけを書ける。Issue内のpromptはuntrusted dataとして
    扱い、AI判定自身は`ready`を付けられない。
11. 人間がexact `ready` labelを付けた場合だけ、triageが直前snapshotとlive leaseを再確認する。
    `promote_triage_job` capabilityはtriage leaseの完了とidentity-only development jobのenqueueを同一transactionで
    行う。ready／claimed labelはpromotion時の設定値をrunner payloadへ運び、repository固有の暗黙labelを持たない。
12. triageは専用OCI targetとprocessにするが、schema／migration／lifecycleを原子的にreleaseする必要があるため、
    現時点ではWorkflow repository内に置く。独立versioning・別運用主体が必要になった時だけ別repositoryへ抽出する。

## 帰結

- controlは引き続きGitHub credentialを持たず、triage-only typed brokerでprivate repositoryのIssue/PR monitorを
  両modeとも同時に収束できる。
- PostgreSQLはrequest、lease、failure、digest auditの唯一のdurable SoTであり、restart後もpending/expired workを回収する。
- triage DB roleは期限内の自己leaseに対する限定monitor／promotion capabilityだけを持つ。development runner DB roleは
  broker responseやtriage terminal stateを直接操作できない。
- PostgreSQL containerは起動時image digest＋credential-redacted canonical specへsealされ、credential値はactualと
  process内だけで比較する。admin credential rotationはDRAINING・zero workでtransactionalに旧credential失効を
  検証してからvolume-preserving restartする。
- GitHub webhook forwardingの汎用proxyではない。webhook ingressは既存の署名検証・delivery dedup境界を使う。
- control imageはGitHub credentialに加えて`gh`／`gh-webhook` executableも持たない。private repositoryの
  webhookは署名済みControl API ingressだけで受け、pollはtyped brokerだけを使う。従来adapterのcode/testは
  compatibility oracleとして残るが、このcredential-free topologyで起動成功を主張しない。
- 匿名pollがprivate repositoryで404になった初回失敗は証跡から消さず、broker cutoverの理由として残す。

## 実装先 id

- architecture: `ARCH-control-store-016`、`ARCH-container-runtime-015`
- domain-model: `DOM-control-store-013`〜`015`、`DOM-container-runtime-013`
- data-model: `DATA-control-store-017`〜`018`、`DATA-container-runtime-008`
- ubiquitous-language: `LANG-control-store-020`〜`025`、`LANG-container-runtime-016`〜`018`
