# アーキテクチャ — container-runtime コンテキスト

> OS 非依存の port と、Apple Container/macOS 固有処理を閉じ込める adapter 境界だけを定義する。
> 各 id は [ADR-0011](../../decisions/ADR-0011-standard-oci-image-and-container-runtime-adapter.md)（AC-CISO-011）を
> 根拠とする。追加のみ。

- **ARCH-container-runtime-001 runtime-neutral port** — publicな形: `ContainerRuntime`（`capability` の非 mutating
  観測、`buildImage`／`createNetwork`／`removeNetwork`／`createVolume`／`removeVolume`／`runContainer`／
  `stopContainer`／`removeContainer`／`execInContainer`）。CLI 名も macOS API も port 上に現れない。core と他コンテキストは
  この port だけを import する。
- **ARCH-container-runtime-002 adapter isolation** — publicな形: `CliContainerRuntime` 基底が中立な docker 互換 verb の
  argv を組み、runtime 固有に分かれる部分（`CliDialect`＝network/volume 削除 verb・stop timeout flag、capability probe、
  version/arch 解釈）だけを subclass へ委ねる。`AppleContainerRuntime` が Apple Container 固有処理の唯一の住処、
  `OciCliRuntime`（docker/podman 互換）が境界の runtime 中立性を接地する。未対応 runtime は別 runtime へ fallback せず
  fail-closed。
- **ARCH-container-runtime-003 fail-closed preflight** — publicな形: `runPreflight(runtime, requirements):
  PreflightReport`。非 mutating capability（CLI/version/arch/service）＋要求時の grounded lifecycle probe
  （network/volume の create+delete、probe image の run）。required check が1つでも不成立なら `ok:false`、前提失敗後の
  check は「not evaluated」、例外も捏造 pass も出さない。
- **ARCH-container-runtime-004 publish invariant（静的）** — publicな形: `inspectPublishInvariant(topology)`／
  `assertPublishInvariant(topology)`。desired topology を起動前に検査し、control だけが 127.0.0.1 へ publish、
  runner/postgres は publish を持たず、全 container が単一の内部 network に属することを保証する。
- **ARCH-container-runtime-005 publish invariant（grounded）** — publicな形: `verifyHostPublishSurface(expectation,
  probe)`。runtime 非依存の Mac loopback probe（`tcpLoopbackProbe`）で、control 到達可・内部 port（postgres 5432 等）は
  Mac で拒否、を running topology に対して接地する。CLI の inspect JSON 形に依存しない。
- **ARCH-container-runtime-006 container-neutral paths** — publicな形: `resolveContainerPaths(env)` が container 絶対の
  既定を env で上書き可能にしつつ Mac home path を fail-closed 拒否、`scanForHostPathDependencies(root)` が build/runtime
  surface の hardcoded Mac 絶対 path を回帰検査する。
- **ARCH-container-runtime-007 standard OCI build seam** — publicな形: `deploy/Containerfile` の multi-stage
  （`deps → build → runtime`）。Apple 専用構文なし、`build` stage の in-container typecheck、Go control builder stage を
  後から差し込む seam。標準 OCI なので docker/podman でも同一に build/run できる。
- **ARCH-container-runtime-008 isolated runner stage** — standard OCIの`runner` stageはuid 65532、専用HOME、
  `/workspace` private volume、zero host ports、read-only root/capability dropの起動契約でlease consumerを実行する。
- **ARCH-container-runtime-009 startup isolation proof** — runnerはHOME/cwd/mount/publish/outboundとcredential/socket不在を
  DB接続・provider実行前にfail closed検証し、secret値を含まない検証結果をcontrol-store auditへ残す。
- **ARCH-container-runtime-010 Registration workspace** — mirror/worktree/state/artifactは
  `/workspace/registrations/<id>`だけに置き、job/attempt pathはDB identityから決定論的に導出する。
- **ARCH-container-runtime-011 Short-lived lifecycle owner** — `agentopsctl`だけがApple Container systemと
  named topologyを操作し、終了後にhost-native daemonを残さない。
- **ARCH-container-runtime-012 Actual publish proof** — reachabilityに加えてrunning inspectのexact
  `127.0.0.1:<port>:8080/tcp` 1件、runner/PostgreSQLのempty publish/socketを検査する。
- **ARCH-container-runtime-013 Internal egress bridge** — internal-only runnerはcontrol上のCONNECT allowlistを経由し、
  GitHub/GitHub API/選択providerの443だけへ到達する。PostgreSQLはactual internal IPv4で直接到達する。
- **ARCH-container-runtime-014 Scoped compensation** — partial startは当該試行が変更したcontainerだけを停止・削除し、
  named volumeと既存in-flight topologyを保存する。
- **ARCH-container-runtime-015 Runner-only monitor credential boundary** — private repository read credentialとCodex credentialは
  runnerだけへ渡す。controlのGitHub credentialは空のまま、runnerはinternal network上のcontrol egress allowlist経由で
  固定typed monitor endpointへ出る。MONITOR_ONLYでもrunner-only GitHub credentialとGitHub broker egressで
  brokerは動くが、Codex/provider credential・provider egressを持たず、execution leaseはmode fenceが拒否する。
- **ARCH-container-runtime-016 Sealed PostgreSQL rotation boundary** — PostgreSQL actualはimage descriptorと
  credential-redacted canonical spec digestへsealし、credential値はactual比較とauthentication probeだけで検証する。
  driftはrunningのまま受理せず、DRAINING・zero workでtransactionalにadmin credentialを変更・新旧authenticationを
  検証し、OFF後にnamed volumeを保持したspec-consistent restartを行う。

## 段階導入

- #11（CISO-01）: `ARCH-container-runtime-001`〜`007` を一括で確立する（本フェーズが基盤）。
- #14（CISO-04）: `runner` stageとprivate Registration workspaceを`ARCH-container-runtime-008`〜`010`で追加する。
- #16（CISO-06）: `agentopsctl` lifecycleとactual publish/compensationを`ARCH-container-runtime-011`〜`014`で追加する。
- #17（CISO-07）: private monitor credential boundaryとsealed PostgreSQL rotationを
  `ARCH-container-runtime-015`〜`016`で追加する。

## grounded smoke

`scripts/runtime-smoke.ts` が実 engine で全 ARCH を一気通貫に接地する。preflight（003）→ 標準 OCI build（007）→
publish invariant 静的（004）→ 内部 network＋永続 volume → topology 起動 → publish invariant grounded（005）→
container-neutral path（006）を検査し、捏造 pass をせず JSON 証跡を出す。Apple Container での実施が #11 の必須接地、
docker 実行は標準 OCI 可搬性の補助証跡。
