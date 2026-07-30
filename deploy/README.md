# deploy — 標準 OCI アプリケーションイメージと runtime smoke

CISO-01（Issue #11・親 #10）が確立する **標準 OCI ランタイム基盤** の配布物一式。Apple Container 固有形式を使わず、
`container` / `docker` / `podman` のいずれでも同一に build・run できる（AC-CISO-011）。

## Containerfile

`deploy/Containerfile` は multi-stage の標準 OCI ビルド（`deps → build → runtime`）。

```sh
# build 文脈はリポジトリ root
container build -t agentops-app:dev -f deploy/Containerfile .   # Apple Container
docker    build -t agentops-app:dev -f deploy/Containerfile .   # 可搬性（標準 OCI）確認
```

- 全 path はコンテナ絶対（`WORKDIR /app`）。macOS の `/Users/...` を一切参照しない
  （`src/runtime/paths.ts` の scanner が build/runtime surface を静的検査して保証する）。
- `runtime` stage は非 root（`node` uid 1000）で動く。productionの`runner`と
  `triage-runner`はuid 65532で動く。
- `build` stage で `npm run typecheck` を通し、「build/typecheck grader がコンテナ内・コンテナ相対 path で走る」ことを
  ビルド時に接地する。
- `control-build` はGo unit test後に静的`agentops-control`をbuildし、`control-test`はrace/integration用、
  `control`は非rootのproduction imageである。TypeScript `runtime`とは独立したstageなのでrunner release surfaceを
  変更しない。
- `triage-runner`はIssue/PR観測とIssue triage専用で、git／SSH／workspace／container socketを含まない。
  `runner`は開発実行専用で、triageとは別image・DB role・GitHub credentialとして起動する。

## runtime adapter 境界

`src/runtime/` が OS 非依存の core。Apple Container / macOS 固有処理は `apple-container.ts` だけに閉じ、
`oci-cli.ts`（docker/podman 互換）は同じ port を実装して境界が本当に runtime 中立であることを接地する。
preflight・publish invariant・container-neutral path は runtime 実装に依存しない。詳細は
[`docs/_system/container-runtime/`](../docs/_system/container-runtime/architecture.md) と
[`docs/decisions/ADR-0011-*`](../docs/decisions/) を参照。

## grounded smoke

`scripts/runtime-smoke.ts` は実エンジンで topology を一気通貫に立ち上げ、全 AC を接地する。捏造 pass をせず、
preflight 不成立や検査不成立では非 0 で終了し、JSON 証跡を出力する。

```sh
npx tsx scripts/runtime-smoke.ts                  # Apple Container（既定・#11 の必須接地）
npx tsx scripts/runtime-smoke.ts --runtime=docker # 標準 OCI 可搬性の補助証跡
npx tsx scripts/runtime-smoke.ts --keep           # 調査用に topology を残す
```

検査項目: preflight（fail-closed）→ 標準 OCI build → publish invariant（静的）→ 内部 network＋永続 volume →
postgres 公式 image（内部・volume）／control（loopback publish）／runner（内部）起動 → host publish surface 接地
（control は到達可・5432 と control container port は Mac で拒否）→ コンテナ内 `npm run typecheck`（`/app` 相対・
Mac 絶対 path 非依存）→ drain/stop。

## PostgreSQL control store（CISO-02）

明示的なschema migration:

```sh
AGENTOPS_DATABASE_URL='postgresql://…' npm run control-store:migrate
```

通常consumer/runner起動はDDLを変更せずexact version/checksumをverifyしてfail closedにする。Apple Container実機で
transaction/競合/lease/reclaim/LISTEN+reconciliationとpersistent-volume recoveryを再現するには:

```sh
npm run smoke:postgres:apple
```

Apple Containerのext4 named volumeには`lost+found`があるため、volumeは`/var/lib/postgresql`へmountし、
`PGDATA=/var/lib/postgresql/data`を指定する。PostgreSQLとrunnerにhost publishはない。

## Registration-driven Go control（CISO-03）

```sh
container build --target control -t agentops-control:dev -f deploy/Containerfile .
container run --detach --name agentops-control \
  --network <internal-network> \
  --read-only --cap-drop ALL --tmpfs /tmp \
  --publish 127.0.0.1:8080:8080 \
  --env AGENTOPS_DATABASE_URL='postgresql://…' \
  --env AGENTOPS_CONTROL_TOKEN='<32+ byte random operator-token>' \
  --env AGENTOPS_OPERATING_MODE='MONITOR_ONLY' \
  --env AGENTOPS_DASHBOARD_ORIGIN='http://127.0.0.1:8080' \
  --env AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN='<single-use-random-token>' \
  --env AGENTOPS_GITHUB_WEBHOOK_SECRET='<webhook-secret>' \
  --env AGENTOPS_GITHUB_MONITOR_BROKER_REPOSITORIES='owner/repo-a,owner/repo-b' \
  agentops-control:dev
```

container内のControl API本体は`127.0.0.1:8081`にbindし、port 8080の同一process publication proxyだけを
host loopbackへpublishする。PostgreSQL/runnerはpublishしない。browserは起動logの
`/dashboard/bootstrap?token=…` を一度だけ開き、clean URLへredirect後はHttpOnly session cookieとmemory-only
CSRF proofだけを使う。host側portが8080以外なら`AGENTOPS_DASHBOARD_ORIGIN`もそのexact loopback originへ合わせる。
root filesystemはread-only、capabilityはALL drop、writable領域は`/tmp`のtmpfsだけとし、host filesystemや
container runtime socketはmount/publishしない。
通常起動はDDLを変更せずschema version 7と
全migration checksumをverifyする。起動前にpinned Experience Design Bundleのapproval/revision/digest/capability
coverageも検証し、不一致ならHTTP serverを開始しない。

実Apple Containerでdynamic enable/disable、desired/actual、DB切断fail-closed、同process reconnect、
control restart reconstruction、publish surfaceを接地する:

```sh
npm run smoke:control:apple
```

Issue #15 dashboard boundaryまで含む証跡は`npm run smoke:dashboard:apple`で
`evidence/ciso-05/dashboard-apple-container-smoke.json`へ出力される。

## Capability-limited triage runner

```sh
container build --target triage-runner -t agentops-triage:dev -f deploy/Containerfile .
```

`triage-runner`はprivate Issue/PRのtyped monitor brokerを両modeで処理する。`MONITOR_ONLY`では
AI providerを呼ばず、観測結果だけをcontrolへ返す。`ACTIVE`ではIssue本文、bounded comment、
repositoryのNorth Star/roadmap文書、近傍Issue titleだけを読み、strict JSON判定から管理対象ラベルと
marker付きcommentだけを書ける。人間がexact ready labelを付けた場合だけ、DBの
`promote_triage_job` capabilityがtriage lease完了とdevelopment job作成を同一transactionで行う。

このimageにはworkspace volume、git、SSH、開発用GitHub token、control token、runtime socket、
host path/portがない。DB role `agentops_triage`はmonitor claim/complete/failとtriage promotionに限定され、
`agentops_runner`からmonitor capabilityはrevokeされる。

## Isolated AgentOps development runner（CISO-04）

```sh
container build --target runner -t agentops-runner:dev -f deploy/Containerfile .
npm run smoke:runner:apple
```

`runner`はuid 65532、`/home/agentops`専用HOME、`/workspace` private named volume、read-only root filesystem、
capability drop ALL、host publishなしで起動する。起動時にmount/publish/outboundとMac HOME／開発root／SSH agent／
Apple Container socket／control credential不在を検証し、provider/GitHub子processにはDB credentialを渡さない。
job/result/failureは`contracts/control-store/v1/runner-*.schema.json`のversion 1だけを受理し、unknown schemaは拒否する。
development runnerは`ACTIVE`にだけ存在する。repository名ではなく、checkoutしたimmutable-at-claim
`package.json`からbounded grader profileを選ぶ。TypeScript/Vitest、またはshell演算子を含まない
direct `node <relative-script>` contract checkerだけを受理し、job payloadから任意commandを受け取らない。

Apple Container smokeはinternal network上のrunner/PostgreSQL、lease競合・expiry・restart recovery、全critical boundaryの
Registration stale race、lease loss、artifact tamper、zero host port、private volumeを接地し、
`evidence/ciso-04/apple-container-smoke.json`へmachine-readable証跡を出力する。

## `agentopsctl` lifecycle（CISO-06）

Mac側の常駐daemonを追加せず、短命なGo CLIだけでApple Container topologyを操作する。Apple Container systemは
既存の付与済み権限で起動し、brew installは行わない。credentialはshell historyへ直接書かず、operator管理の
permission 0600 env fileなどからexportする。

```sh
export AGENTOPS_POSTGRES_PASSWORD='<32+ bytes: admin only>'
export AGENTOPS_CONTROL_DB_PASSWORD='<32+ bytes: distinct control role>'
export AGENTOPS_TRIAGE_DB_PASSWORD='<32+ bytes: distinct triage role>'
export AGENTOPS_RUNNER_DB_PASSWORD='<32+ bytes: distinct runner role>'
export AGENTOPS_CONTROL_TOKEN='<32+ bytes>'
export AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN='<32+ bytes>'
export AGENTOPS_GITHUB_WEBHOOK_SECRET='<32+ bytes>'
export AGENTOPS_MONITOR_REPOSITORIES='owner/repo-a,owner/repo-b'
export AGENTOPS_RUNNER_REPOSITORIES='owner/repo-b'
export AGENTOPS_GITHUB_APP_ID='<numeric App id>'
export AGENTOPS_GITHUB_APP_INSTALLATION_ID='<numeric installation id>'
export AGENTOPS_GITHUB_APP_SLUG='<canonical app slug>'
export AGENTOPS_GITHUB_APP_OWNER='owner'
export AGENTOPS_GITHUB_APP_PRIVATE_KEY_FILE='<absolute mode-0600 .pem path>'
# Optional: agentopsctl generates both broker capabilities into a private
# ~/.agentops/<prefix>/broker-capabilities.json unless an external secret manager supplies them.
# export AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY='<43..128 URL-safe characters>'
# export AGENTOPS_GITHUB_BROKER_RUNNER_CAPABILITY='<different 43..128 URL-safe characters>'
export AGENTOPS_RUNNER_PROVIDER=codex
export OPENAI_API_KEY='<ACTIVE triage/development provider credential>'

go run ./cmd/agentopsctl start --mode MONITOR_ONLY --build --request-id operator-start-001
go run ./cmd/agentopsctl start --mode ACTIVE --request-id operator-active-001
go run ./cmd/agentopsctl status --json
go run ./cmd/agentopsctl logs --component triage --lines 200
go run ./cmd/agentopsctl logs --component runner --lines 200
go run ./cmd/agentopsctl open
go run ./cmd/agentopsctl drain --timeout 10m --request-id operator-drain-001
go run ./cmd/agentopsctl stop --timeout 10m --request-id operator-stop-001
```

`open`はcontrolログから最新のone-time bootstrap URLを選び、session未確立ならcookieを発行して
Dashboardへredirectする。既存の有効sessionはtokenを消費せず再利用し、新規sessionがtokenを
消費した直後に次のURLがcontrolログへrotationされる。

mode graphは`OFF → MONITOR_ONLY → ACTIVE → DRAINING → OFF|MONITOR_ONLY`。同一`--request-id`はdurableに
replayされ、不正遷移は拒否・監査される。DRAININGはDB commit後にrouting/enqueue/leaseを止め、SIGTERMを受けたrunnerが
現在attemptを閉じるまで待つ。timeoutはforce killせず非0終了し、statusへdeadline/timeout/last errorを残す。

controlだけがexact `127.0.0.1:${AGENTOPSCTL_CONTROL_HOST_PORT:-8080}:8080/tcp`を1件publishする。
GitHub App broker／triage／runner／PostgreSQLはhost port/socket/host path/runtime socketを持たない。
brokerだけが秘密鍵named volumeをread-only mountし、triageはworkspace volumeを持たず、runnerだけが
private workspace volumeを持つ。`MONITOR_ONLY` topologyはPostgreSQL＋control＋GitHub App broker＋triageで、
`ACTIVE`だけdevelopment runnerを追加する。`agentopsctl logs --component github-broker`でtoken値を含まない
readiness／failureだけを確認できる。
通常stopはcontainerを削除してListen消失を検査するがnamed volumeは保存する。start途中失敗では、
そのstartが変更したcontainerだけを補償停止し、既存in-flight topologyとvolumeは保持する。詳細は
[ADR-0016](../docs/decisions/ADR-0016-agentopsctl-lifecycle-authority.md)と
[`evidence/ciso-06/`](../evidence/ciso-06/)を参照する。
