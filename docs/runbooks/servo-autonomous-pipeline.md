# Servo 自律開発パイプライン運用

対象は `mrbaron3/servo` だけである。repository authority は PostgreSQL の
Registration であり、process 環境変数の allowlist は使わない。fresh schema 21 は
`mrbaron3/servo` を唯一の enabled Registration として、release receipt policy と
既定 gate SLA 3600 秒を含めて作成する。

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

初回は副作用のない監視 mode から始める。

```sh
mise run monitor
mise run open
```

Dashboard の既定 URL は `http://127.0.0.1:8080/` である。認証済み URL は一回限りの
bootstrap token を含むため、ログや文書へ貼らず `mise run open` で開く。Registration
一覧が `mrbaron3/servo` 一件だけ、Issue/PR Monitor と Execution が enabled、実際の
GitHub 到達性が running であることを確認する。permission 不足、repository 不達、
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

Dashboard の repository 別 Kanban は `ready`、`intake/planning`、`design`、
`implementation`、`review round N`、`repair`、`gate wait`、`human escalated`、
`merge ready`、`released`、`failed` を分ける。card には job/attempt、lease owner、
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
2. 現行 schema 21 を理解する revert/forward-fix commit を Servo の別 worktree で用意し、対象 commit、
   migration compatibility、rollback 理由を review する。schema を知らない古い binary は起動しない。
3. その clean worktree を `AGENTOPSCTL_PROJECT_ROOT` にして `go run ./cmd/agentopsctl deploy` を実行する。
4. `status:json` の provenance、Dashboard health、Servo Registration、直前の terminal/current Issue
   projectionを再確認する。PostgreSQL/runner volume は保存されるので、同じ release/job identity から
   recovery する。

## 実環境 smoke の境界

安全な最小 smoke は `MONITOR_ONLY` の Servo Registration read、dashboard projection、broker health
までである。この smoke は Issue label/comment、PR、merge、release を変更しない。ACTIVE の ready claim、
child Issue 作成、push、merge は実 GitHub 上の破壊的 rehearsal として行わず、fake GitHub の headless E2E、
PostgreSQL integration、isolated git worktree test で先に証明する。実 Issue を使う場合は対象 Issue と許可する
side effect を人間が明示した後だけ実施する。
