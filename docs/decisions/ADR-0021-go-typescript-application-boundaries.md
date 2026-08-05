# ADR-0021: GoとTypeScriptを別application rootへ分離し、共有境界とrelease unitを明示する

- 状態: 採択・system viewへ吸収済み・構造反映済み
- 関連: [ADR-0011](ADR-0011-standard-oci-image-and-container-runtime-adapter.md)、
  [ADR-0013](ADR-0013-postgresql-control-plane-source-of-truth.md)、
  [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md)、
  [ADR-0016](ADR-0016-agentopsctl-lifecycle-authority.md)、
  [ADR-0019](ADR-0019-github-app-credential-broker.md)、
  [ADR-0020](ADR-0020-release-receipt-evidence.md)

## 文脈

repository rootの`cmd/`・`internal/`にGo、`src/`・`test/`・`scripts/`にTypeScriptがあり、
一つのapplicationを言語別directoryで実装しているように見えていた。しかし実際には、Go control-planeと
TypeScript AgentOpsは異なるentry point、process、credential、runtime roleを持つ別applicationである。
所有境界が物理構造に現れないと、どちらのbuild/test/dependencyがどのruntimeを作るか、rootのschemaや
Containerfileを誰が所有するかが曖昧になる。

両applicationはPostgreSQLの同じcontrol-storeを利用する。一方で、runtimeにはcredential broker HTTP、
egress proxy、shared volume、container lifecycleのpoint-to-point接続も存在する。「橋渡しはDB」とだけ書くと、
durableな業務状態の正本と、秘密・通信・大きなartifact・process操作のsecurity/runtime境界を混同する。

また両consumerは起動時にmigration version/name/checksumのexact一致を要求し、短命なlifecycle ownerが
schema migrationと同一revisionのimage topologyをまとめて収束させる。source directoryの分離だけで
independent deployment compatibilityが成立したとは言えない。

## 決定

1. **application source rootを二つに固定する。**
   Go control-planeは`apps/control-plane/`、TypeScript AgentOpsは`apps/agentops/`を所有する。
   repository rootに`cmd/`・`internal/`・`src/`・`test/`等のapplication source rootを再導入しない。
   rootの`package.json`と`go.work`はdeveloper command/workspace routerであり、第三のapplicationではない。
2. **language-neutralな共有境界はrootに置く。**
   `db/control-store/migrations/`は両consumerが検証するSQL contract、`contracts/`はJSON Schemaと
   OpenAPIのPublished Languageである。どちらか一方のapplication配下へ移さない。
   `deploy/`は両applicationとPostgreSQLを標準OCI image/topologyへ組み立てるintegration layerであり、
   application sourceの所有境界ではない。image構成専用の`provider-cli`・`gh`・`gosu`は
   `deploy/tools/`が所有し、application dependencyへ見せない。
3. **cross-applicationのdurable business coordinationはPostgreSQLだけを正本にする。**
   Registration、cursor、delivery、lifecycle mode/generation/drain fence、monitor broker request/response、
   job、lease/attempt、result/failure、
   development progress、release receipt、artifact URI/digest metadataは`agentops_control`へtransactionalに
   保存する。GoがenqueueしTypeScriptがclaimする場合も、その逆方向のresult/progressをGoが読む場合も、
   rootのSQL/JSON contractへ順応する。`LISTEN/NOTIFY`はwake-up hintに限定し、失われた通知はqueryによる
   periodic reconciliationで回収する。process memory、HTTP response、volume上のfileを業務状態の別SoTにしない。
4. **DB以外の接続を別のsecurity/runtime contractとして明示する。**
   - credential: TypeScript processはrole capabilityを持つGo credential helperを起動し、helperだけが
     internal GitHub credential broker HTTPから短期installation tokenを得る。tokenをDBへ保存しない。
   - egress: internal-only runner/triageの許可済み443通信はGo control-planeのCONNECT proxyを通る。
     proxyはjob busでもdurable state storeでもない。
   - workspace/artifact: checkout、worktree、大きなlog/artifactはrunnerのshared volumeへ置く。
     durableな参照に必要なURI、digest、release/receipt linkだけをPostgreSQLへ保存する。
   - lifecycle: `agentopsctl`がbuild、migration、start、drain、stop、recoveryとactual topologyを操作する。
     mode/generation/drain fenceはPostgreSQLへ保存するが、container runtime commandをDB jobとして
     TypeScriptへ配送しない。
   Control APIはoperator/browserの管理境界であり、TypeScript runnerへの業務dispatch transportにはしない。
5. **TypeScript評価storeをcontrol-storeと混同しない。**
   `.harness/db.json`は`apps/agentops`内のlocal evaluation/planning domainのSoTとして残す。
   Go applicationはこれを読まず、PostgreSQLのmirrorやcross-application bridgeとして使わない。
6. **当面のrelease unitはrepository全体で一体とする。**
   directory、module、package、testの所有は分離するが、Go/TypeScript imageとroot`db/`・`contracts/`・`deploy/`は
   同じconsumer revisionとしてbuild/releaseする。exact schema/checksum gateと`agentopsctl`のstaged lifecycleを
   保つ間は、片方だけを独立version/deploy可能とは表明しない。将来独立releaseへ進む場合は、expand/contract migration、
   consumer compatibility range、published contract version、artifact provenanceを先に設計し、新ADRでこの決定を
   supersedeする。
7. **歴史記録は意味を保持し、現在位置を読めるようにする。**
   移設前に採択・凍結されたADR、spec、handoffの`src/`・`test/`・`scripts/`・`agents/`・`seed/`は
   現在の`apps/agentops/`配下、`cmd/`・`internal/`は`apps/control-plane/`配下へ対応する。
   historical commandや当時のscopeを現在の事実として改変せず、current-state viewとrunbookの実装pathは
   新しい物理位置を使う。

## 帰結

- GoとTypeScriptのdependency、entry point、test、ownerをapplication単位で探索できる。
- rootに残るSQL、schema、OpenAPI、Containerfileは「混ざったsource」ではなく、明示した共有・統合境界になる。
- PostgreSQL障害やcontract mismatchではdurable coordinationをfail closedする一方、credential、network、
  volume、lifecycleにはそれぞれ固有のthreat modelと検証が必要である。DBの検査だけで全境界を証明したとは扱わない。
- exact migration gateにより現在のrolloutは単純で厳格だが、片側だけのrollback/forward deployはできない。
  directory分離そのものをavailabilityやindependent deployの保証に数えない。
- `.harness/db.json`と`agentops_control`は異なるbounded contextを持ち、dual-writeや推測同期を導入しない。

## 実装先 id

- architecture: `ARCH-control-store-020`、`ARCH-container-runtime-017`、
  `ARCH-registration-control-015`、`ARCH-webhook-008`
