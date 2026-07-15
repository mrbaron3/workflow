# アーキテクチャ — workspace コンテキスト

## モジュール境界とseam

- **ARCH-workspace-001 target identity resolver** — 責務: harness rootとtarget設定から
  `DOM-workspace-002`を得る。public shape: `resolveTargetIdentity(config, harnessRoot): TargetIdentity`。
  存在するrepositoryの正規化済みrootを返し、表記上の `.` / 絶対path / symlink差をidentity差にしない。
- **ARCH-workspace-002 mutation preflight** — 責務: state-changing operationの共通入口で
  `DOM-workspace-004/005`を強制する。public shape:
  `prepareStoreMutation(store, targetIdentity): 'matched' | 'bound-empty'`。MismatchまたはLegacy Unbound Storeは
  理由付き例外となり、呼出し先は未実行のまま。
- **ARCH-workspace-003 legacy binding seam** — 責務: `LANG-workspace-007`を人間が選んだ現在targetへ一度だけ
  移行する。public shape: `bindLegacyStore(store, targetIdentity): 'bound' | 'already-bound'`。既存bindingの
  置換は提供しない。
- **ARCH-workspace-004 CLI mutation boundary** — 責務: plan / authoring / issue lifecycle / execution / evaluationの
  状態変更コマンドを一つのpreflight集合に通す。read-onlyコマンドは`DOM-workspace-007`に従い通過する。

## 共有基盤

- Target Bindingの正本はZod DB schemaであり、configは要求するtargetの入力にすぎない。config変更でbindingは変わらない。
- target repositoryへOrganization Storeを作らない。Workspace分離は各harness rootのstore分離で実現する。

## 横断ポリシー

- **fail closed**: identity解決不能・legacy未移行・mismatchはいずれも書込み前に停止する。
- **決定論**: 同じstore状態とTarget Identityから同じpreflight結果を返す。時刻は新規bindingの監査値にのみ使う。
- **never silent**: エラーはbound targetとrequested target、次に取れる安全な操作を報告する。

## アーキテクチャ不変条件

- **ARCH-workspace-005** — target照合を個別commandへ再実装しない。全state-changing CLI entryは
  `ARCH-workspace-002/004`の共通seamを通る。
- **ARCH-workspace-006** — downstream operationが失敗したとき、preflight以外の部分的なtarget-binding書換えや
  rebindを行わない。
- **ARCH-workspace-007 target-rooted authoring resolver** — publicな形:
  `resolveTargetRoot(config, harnessRoot): string`。`config.target.repo`をharness rootに対して解決し、未設定は
  harness rootを返す。spawn-specs/signはこのseamから文書・git rootを得て、spawn-issues/contract-draftは
  SpecStateのtarget相対dirと同じsystem layerを解決する。外部repoへOrganization Storeやcommitを作らない。
