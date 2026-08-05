# Servo 自律開発パイプライン運用

対象は `mrbaron3/servo` だけである。repository authority は PostgreSQL の
Registration であり、process 環境変数の allowlist は使わない。fresh schema 22 は
`mrbaron3/servo` を唯一の enabled Registration として、release receipt policy と
既定 gate SLA 3600 秒を含めて作成する。

Go control-planeは`apps/control-plane/`、TypeScript AgentOpsは`apps/agentops/`に分離している。
両者のdurable business coordinationはroot `db/` / `contracts/`に従うPostgreSQLで行う。
credential broker HTTP、CONNECT egress proxy、runner shared volume、`agentopsctl`のactual container操作は
別境界（lifecycle mode/drain fenceはDB-backed）だが、
schema/checksumとimage revisionを揃えるため当面のrelease unitはrepository全体で一体である
（[ADR-0021](../decisions/ADR-0021-go-typescript-application-boundaries.md)）。

## 固定 toolchain と更新方針

2026-08-04 時点の production 固定値は Node.js 24.19.0 LTS、npm 12.0.2、
TypeScript 7.0.2、Vite 8.2.0、Vitest 4.1.10、Playwright 1.62.1、Zod 4.4.3、
Go 1.26.5、PostgreSQL 18.4、Debian 13 (trixie)、GitHub CLI 2.97.0、
Codex CLI 0.146.0、Claude Code 2.1.221、gosu 1.19 である。OCI base は version tag
だけでなく manifest digest、Debian package は 2026-08-04 snapshot と exact version で固定する。
`@types/node` は全 major の最新版ではなく、production Node 24 と一致する 24 系最新版を使う。
package manager は npm に統一し、Node base image に同梱される未使用の Yarn Classic は production
image から削除する。
Go はアプリが直接利用する module と配布 binary 本体を最新版にする。
`deploy/tools/gh` の推移依存は
GitHub CLI 2.97.0 が選んだ検証済み MVS graph に従い、`go get -u all` で上流の選択を個別に
上書きしない。

Node.js 26.6.0 は Current であり LTS ではない。Node 26 系の LTS 予定日は
2026-10-28 だが、その時点の exact version は事前に仮定しない。自律パイプラインでは
Node.js の production 推奨に従い、LTS 化、依存 compatibility、同じ headless/OCI 検証が
揃った更新 PR でのみ major を進める。

依存更新時は少なくとも次を実行し、`npm outdated` で表示される Node 型定義が意図した
major-line 例外だけであることを確認する。

```sh
npm outdated
npm audit
npm test
mise exec go@1.26.5 -- go test -race ./apps/control-plane/...
mise exec go@1.26.5 -- go vet ./apps/control-plane/...
container build --target runner -t agentops-runner:verify -f deploy/Containerfile .
container run --rm --entrypoint /bin/sh agentops-runner:verify -c \
  'node --version && git --version && gh --version && codex --version && claude --version'
```

## 起動前確認

```sh
git rev-parse HEAD
git status --short
git remote get-url origin
mise run env:check
mise run status
```

deploy/start は origin が `mrbaron3/servo` でない、worktree が dirty、または明示した
`AGENTOPS_RELEASE_CONSUMER_REVISION` が HEAD と違う場合に停止する。`start` は
`--build` なしでは停止するため、古い mutable-tag image を新しい commit として起動できない。
environment reference/digest と provider-default reference/digest は runner image build 後に、
exact HEAD、image descriptor、`deploy/tools/provider-cli` の exact manifest/lock から自動生成する。
operator env に残った古い値を release receipt へ持ち込まない。

初回は副作用のない監視 mode から始める。

```sh
mise run monitor
mise run open
```

Dashboard の既定 URL は `http://127.0.0.1:8080/` である。認証済み URL は一回限りの
bootstrap token を含むため、ログや文書へ貼らず `mise run open` で開く。Registration
一覧が `mrbaron3/servo` 一件だけ、Issue/PR Monitor と Execution が enabledで、poll attemptと
brokerの実観測が更新されることを確認する。Signed Webhook Ingressはactive probeを持たないため、deliveryがない期間に
`forwarder: running`をGitHub到達性の証拠として要求しない。permission 不足、repository 不達、
broker/configuration error は Registration card の actual state と last error に表示される。

## staged ACTIVE deployment

```sh
mise run active
mise run status
mise run status:json
```

`mise run active` は `agentopsctl deploy` である。順序は次の通り。

1. clean な exact HEAD、Servo origin、provenance override を検証する。
2. 既に ACTIVE なら PostgreSQL を DRAINING にして新規 enqueue/lease/side effect を fence し、
   current lease と attempt が自然終了し、runner/triage が停止するまで待つ。timeout 時は
   force kill や migration をせず非ゼロで停止する。
3. 全 OCI image を現在 HEAD から再 build し、additive/checksum-gated migration を一 transaction
   で適用する。
4. control、credential broker、triage を検証し、provider auth probe と runner readiness が
   通った後だけ ACTIVE を commit する。

`status` の `provenance` は dashboard/control と runner の commit を表示する。ACTIVE では
`consistent=true` かつ両 revision が `git rev-parse HEAD` と一致しなければ運転を開始しない。
Dashboard header も `mrbaron3/servo@<12桁>` を表示する。

## Issue、gate、review、escalation の確認

```sh
mise run progress -- mrbaron3/servo#<issue-number>
mise run progress -- --json mrbaron3/servo#<issue-number>
mise run worktree -- --diff mrbaron3/servo#<issue-number>
mise run logs -- --component runner
```

Dashboardのrepository別Kanban（`LANG-execution-025`）は、表示labelとして`ready`、`intake / planning`、
`design`、`implementation`、`review`（card内にround N）、`repair`、`gate wait`、`human escalated`、
`merge ready`、`released`、`failed`を分ける。filter/APIが使うlane idは
`ready|intake-planning|design|implementation|review|repair|gate-wait|human-escalated|merge-ready|released|failed`で、
表示labelをidとして保存しない。card には job/attempt、lease owner、
worktree、branch、PR、current head、開始/更新時刻、gate と待機秒、review perspective と
finding、child lineage を表示する。current 表示は最新 log event ではなく、job/lease/release
の terminal fact を優先する durable projector である。

gate SLA は Registration 編集画面で default と planning/design/repository-graders/review/merge
ごとに 60〜2,592,000 秒を設定する。超過時は gate/head ごとに一件だけ human escalation が
作られ、理由、evidence、待機時間、対象 SHA、次の人間操作が card に表示される。gate が進むか
job/release が terminal になると escalation は解決済みになる。

`failed` または `human escalated` では card の blocker と human action に従う。retained worktree
を調べる場合だけ `worktree --diff`、手修正が必要な場合だけ `worktree --shell` を使う。
claimed 表示に live lease が無ければ `gate wait / lease recovery` となり、有限 retry 後は
terminal failure と具体的な再開操作へ移る。

## review で独立問題が見つかった場合

現在の acceptance criteria を同じ head で満たすための局所修正は `in-change`、独立した
acceptance criteria・所有境界・検証単位を持つ問題は `separate-issue` とする。後者は automation
marker 付き child Issue を一件だけ作り、発見元 Issue/PR/review round/finding、親 branch、親 head
を本文と PostgreSQL DAG の両方へ保存する。

child runner は main でなく exact parent head を checkout し、別 worktree/child branch を作る。
child PR の base は parent integration branch である。親 merge gate は全 direct child が integrated、
各 child は全 descendant が integrated、さらに全 integrated head が current cumulative parent head の
ancestor になるまで閉じる。cycle、別 finding への identity 再利用、親 head drift、orphan release は
fail closed になる。

## rollback

schema down migration、volume 削除、実行中 job の強制中断は行わない。promotion 後に問題が見つかったら
次の順で戻す。

1. `mise run drain` で current job を保護して DRAINING を完了する。
2. 現行 schema 22 を理解する revert/forward-fix commit を Servo の別 worktree で用意し、対象 commit、
   migration compatibility、rollback 理由を review する。schema を知らない古い binary は起動しない。
3. その clean worktree を `AGENTOPSCTL_PROJECT_ROOT` にして
   `go run ./apps/control-plane/cmd/agentopsctl deploy` を実行する。
4. `status:json` の provenance、Dashboard health、Servo Registration、直前の terminal/current Issue
   projectionを再確認する。PostgreSQL/runner volume は保存されるので、同じ release/job identity から
   recovery する。

### PostgreSQL 16 から 18 への境界

PostgreSQL の major data directory は binary 互換ではない。起動前プローブは named volume 内の
`/var/lib/postgresql/data/PG_VERSION` と `/var/lib/postgresql/18/docker/PG_VERSION` を読むだけで、
legacy layout、18 以外の current layout、両 layout の混在を検出すると container/volume を削除せず
停止する。したがって、旧 16 volume に対して 18 が空クラスタを作り、dashboard から既存 state が
消えたように見えることはない。

既存 16 deployment は DRAINING 完了後、同じ PostgreSQL 18 image を使う一時 restore volume へ
`pg_dump`/`pg_restore` の検証済み logical migration を行い、schema version/checksum、registration、
job/release projection の件数と restart reconstruction を確認してから volume を切り替える。旧 volume は
rollback 証拠として保持する。この migration を完了するまで通常の `start` / `deploy` は意図的に
fail closed となる。

## 実環境 smoke の境界

安全な最小 smoke は `MONITOR_ONLY` の Servo Registration read、dashboard projection、broker health
までである。この smoke は Issue label/comment、PR、merge、release を変更しない。ACTIVE の ready claim、
child Issue 作成、push、merge は実 GitHub 上の破壊的 rehearsal として行わず、fake GitHub の headless E2E、
PostgreSQL integration、isolated git worktree test で先に証明する。実 Issue を使う場合は対象 Issue と許可する
side effect を人間が明示した後だけ実施する。
