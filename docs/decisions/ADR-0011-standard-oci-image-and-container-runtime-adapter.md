# ADR-0011: 標準OCIイメージとcontainer runtime adapter境界でApple Container/macOS依存をcoreから隔離する

- 状態: 採択・吸収・構造実装済み（**Apple Container 上の grounded smoke は未接地＝ユーザー承認待ち**。docker 上の
  同一 topology smoke は全検査 pass 済みだが代替にはしない — 完了条件は Apple Container 実機接地）
- 親: #10（CISO tracking epic）／所有Issue: #11（CISO-01）／所有AC: **AC-CISO-011**
- preserves:
  - 親#10 セキュリティレッドライン（PostgreSQL 5432 を Mac へ publish しない・HOME/開発 root を mount しない・
    任意 command を保存/実行しない）
  - OS 非依存 core（[ADR-0010](ADR-0010-webhook-ingress-and-multi-repository-control-plane.md) 「Runtime と GUI」の
    core は OS 非依存の原則と整合）
  - fail-closed 原則（[ADR-0003](ADR-0003-hard-gates-before-score.md)）

## 文脈

親#10 は PR・Issue・Dashboard を含む長時間稼働基盤を Mac ホストから隔離し、標準 OCI イメージを Apple Container で
実行して runtime 固有処理を core から分離する方針を採る。その先頭フェーズ #11 は、後続の control（Go）・runner
（TypeScript）・PostgreSQL 実装が **runtime 固有処理や Mac の絶対 path に依存しない** OCI baseline を確立する
（AC-CISO-011）。

課題は4つ。(1) application image が Apple Container 専用形式だと可搬性と回帰基準を失う。(2) container 操作を
散在させると macOS/launchd 依存が core に染み出す。(3) network/volume/image/capability の不足を起動後に踏むと
fail-open になる。(4) grader/workspace/systemDir が Mac の `/Users/...` に結合すると container 内で再現できない。

## 決定

### 1. runtime-neutral な adapter 境界を置く

OS 非依存の port `ContainerRuntime`（build/network/volume/run/stop/rm/exec と非 mutating な capability）を core が
駆動する。Apple Container 固有挙動は `AppleContainerRuntime` **だけ**に閉じ、`CliContainerRuntime` 基底が中立な
docker 互換 verb の argv を組み、runtime 固有に**分かれる**もの（network/volume の削除 verb・stop timeout flag・
capability probe・version/arch 解釈）だけを subclass へ委ねる。generic な `OciCliRuntime`（docker/podman 互換）を
第二実装として置き、境界が本当に runtime 中立であることを接地する。未対応 runtime は別 runtime へ fallback せず
fail-closed。

### 2. application image は標準 OCI とする

`deploy/Containerfile` は Apple 専用構文を持たない multi-stage 標準 OCI ビルド（`deps → build → runtime`）で、
`container`・`docker`・`podman` のいずれでも同一に build/run できる。`build` stage で in-container の `npm run
typecheck` を通し、「build/typecheck grader が container 内・container 相対 path で走る」ことを接地する。Go 製
agentops-control（#13/#16）を後から `control-build` stage として差し込む再現可能な seam を明記する。

### 3. preflight を fail-closed にする

`runPreflight(runtime, requirements)` は非 mutating な capability 検査（CLI/version/arch/service）に加え、要求時に
実 host 境界の lifecycle probe（network/volume の create+delete、probe image の run）を通す。required check が1つでも
不成立なら `ok:false`、前提失敗後の check は「not evaluated」として記録し、例外も捏造 pass も出さない。CLI 未導入・
service 停止・version/arch/network/volume/image の不足を**起動前**に構造化理由で返す。

### 4. control-only-loopback publish 不変条件を二重に接地する

- 静的: `inspectPublishInvariant/assertPublishInvariant(topology)` が desired topology を起動前に検査する。control
  だけが 127.0.0.1 へ publish し、runner/postgres は publish を持たず、全 container が単一の内部 network に属する。
- grounded: `verifyHostPublishSurface(expectation, probe)` が runtime 非依存の Mac loopback probe で、control が到達可・
  内部 port（postgres 5432 等）が Mac で拒否されることを接地する。

### 5. container-neutral path を強制する

`resolveContainerPaths(env)` が container 絶対の既定（`/app`・`/workspace`・`/data/store`・`/app/docs/_system`）を
env で上書き可能にしつつ、Mac home path への解決を fail-closed で拒否する。`scanForHostPathDependencies(root)` が
build/runtime surface（src ＋ build 設定）に hardcode された Mac 絶対 path を回帰検査する（docs/test は対象外＝
稼働 container に入らない例示 path を許す）。

### 6. 永続しない

このコンテキストは `.harness/db.json` へ書かない。preflight/topology/capability は起動ごとに計算する揮発値であり、
唯一の cross-boundary 語彙は `src/runtime/schema.ts` の runtime-neutral な Zod 契約である。

## 帰結

- **AC-CISO-011 を #11 が単独所有**。macOS/launchd 依存は adapter 配下のみに存在し、core と後続コンテキストは port
  だけに結合する。
- 標準 OCI なので docker/podman でも同一に build/run でき、可搬性証跡と回帰基準（PR #9 の TypeScript 版を保持）を
  両立する。
- grounded smoke は **Apple Container で必須**。環境/権限/capability 不足時は部分起動や代替テストで押し切らず、
  理由を返して escalation する。
- trade-off: adapter を2実装持つ薄い重複を負う代わりに、境界の runtime 中立性を接地し、後続フェーズが CLI 形や
  macOS 詳細へ結合するのを防ぐ。

## 実装先 id（この ADR の premises を吸収したビュー）

- architecture: `ARCH-container-runtime-001`〜`007`
- domain-model: `DOM-container-runtime-001`〜`008`
- ubiquitous-language: `LANG-container-runtime-001`〜`009`
- data-model: `DATA-container-runtime-001`〜`005`
