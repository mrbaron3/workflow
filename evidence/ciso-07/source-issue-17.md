# Immutable source snapshot — mrbaron3/workflow#17

- Captured at: `2026-07-26T04:35:00Z`
- Provider revision: `2026-07-24T10:28:37Z`
- Canonical selected-field SHA-256: `acc329987db8776947ee4e79243cd1153cf0d090c5623b50e578426233b2fed9`
- URL: <https://github.com/mrbaron3/workflow/issues/17>
- State at capture: `OPEN`
- Labels at capture: `enhancement`
- Immutable base: `257dc557753b099a646c94d3e3cc700468ffb32a`

## Title

[CISO-07] 3コンテナ構成を統合しE2Eドッグフードする

## Body

Parent: #10
Blocked by: #14, #15, #16

### 目的

agentops-control、agentops-runner、agentops-postgresをApple Container上で統合し、Dashboardで登録したrepositoryだけを監視・実行して、既存AgentOps経路によるmerge／release、drain／stop、restart recoveryまでをgroundedに実証する。

### スコープ

- 3つの標準OCI imageと再現可能なbuild／version pinning
- internal network、loopback publish、persistent volumes、health／readiness
- control／runner／PostgreSQLのcredential bootstrapとrotation手順
- schema migrationを含む安全なstart／upgrade／rollback-safe failure
- test repositoryのDashboard Registration
- Issue MonitorとPR Monitorの同時稼働
- MONITOR_ONLYからACTIVEへの切替と1件の実AgentOps job
- current-head 6観点review、repair、required checks、expected-SHA merge、Issue release
- DRAINING→OFF、Mac Listen消失、DB／artifact永続化、restart後の復元
- logs、audit、artifact digest、PR／Issueへのgrounded evidence記録
- 旧host-native daemon／旧control JSONのcutover確認

### ドッグフード規則

- 本Issue自身を既存GitHub intakeでclaimし、planning provenanceを保存する
- implementation、review、repair、merge、releaseを通常のAgentOps経路から迂回しない
- Webhookだけを成功根拠にせず、poll reconciliationとGitHub current stateを使用する
- expected-SHA不一致、blocking thread、required check失敗、stale Registrationではmergeしない
- 失敗を手作業で成功状態へ書き換えず、attempt／auditへ残す

### 受け入れ基準

- **AC-CISO-012の所有Issue**: 本Issueのclaim、planning、PR作成、head SHA単位review、repair、expected-SHA merge、releaseを既存AgentOps経路で完遂し、証拠を永続化する。
- Dashboardから登録したtest repositoryだけでIssue／PR monitorとrunnerが動作し、未登録repositoryではjobが作成されない。
- MONITOR_ONLYでは監視だけ、ACTIVEではexecutionが動作する。
- controlだけが127.0.0.1へ公開され、runner／PostgreSQLにMac側公開portがない。
- DRAINING後にListenが消え、再起動後にRegistration、cursor、job／attempt、audit、artifact参照が復元される。
- 旧host-native daemonや旧JSON control storeとのdual running／dual writeがない。

### 検証

- full typecheck／全test
- 全OCI image buildとdependency／secret scan
- Apple Container grounded E2E
- registered／unregistered／disabled repository
- Issue／PR両monitor、webhook＋poll dedup
- current-head repair／merge／release
- drain／stop／Listen消失／restart recovery
- PR #9と#11〜#16の回帰
- evidence completenessとartifact digest verification

### 完了条件

Apple Container上でDashboard登録→Issue／PR発見→MONITOR_ONLY→ACTIVE→AgentOps job→expected-SHA merge→Issue release→DRAINING→OFF→Listen消失→restart復元を一巡し、全証拠をcurrent revisionへ束縛したうえでPRがmerge・releaseされる。完了後、親#10を全子Issueのrelease確認付きでcloseする。
