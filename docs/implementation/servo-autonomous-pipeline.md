# Servo 自律開発パイプライン実装メモ

- 対象: `mrbaron3/servo` のみ
- 基準 revision: `3890d2ced849de5afb00bacf06a1cd63c0bdb39f`
- 調査日: 2026-08-04
- 状態: 実装・headless/統合検証済み（live smoke の commit 固定結果は PR に記録）

このメモは production 経路である PostgreSQL control plane、Registration-driven Go
control、capability-limited triage、isolated runner、PR-native review/release を対象にする。
外部製品の issue、PR、実行履歴、設定、repository は入力にも検証 oracle にもしない。

現在の物理配置はGoが`apps/control-plane/`、TypeScriptが`apps/agentops/`である。root `db/` /
`contracts/`のPostgreSQL contractがdurable business coordinationを担い、`deploy/`が両applicationを
同一release unitへ組み立てる（ADR-0021）。

## 実装前チェックポイント

### 実際の状態遷移

| 区間 | durable state / 遷移 | 実装とテスト |
| --- | --- | --- |
| ready 観測 | enabled Registration の Issue monitor が GitHub snapshot を poll し、`agentops.triage` job を冪等 enqueue | `apps/control-plane/internal/control/monitor.go`, `apps/control-plane/internal/control/router.go`, `apps/agentops/src/runner/monitor-broker.ts`, `apps/control-plane/internal/control/monitor_test.go` |
| ready 判定と claim | triage が current Issue を再取得し、人間が付けた exact ready label を確認する。`promote_triage_job` が triage lease 完了、claim、ready-time Source Issue snapshot、release authority、`agentops.runner` job を同一 transaction で確定 | `apps/agentops/src/triage/service.ts`, `apps/agentops/src/control-store/store.ts`, `db/control-store/migrations/0007_multi_repository_triage.sql`, `apps/agentops/test/control-store.integration.test.ts` |
| runner claim | ACTIVE lifecycle と current Registration version を再検証し、single-flight job lease と attempt を取得。heartbeat、expiry reclaim、有限 retry を PostgreSQL に記録 | `apps/agentops/src/runner/service.ts`, `apps/agentops/src/control-store/store.ts`, `db/control-store/migrations/0003_isolated_runner.sql`, `apps/agentops/test/runner-service.test.ts`, `apps/agentops/test/control-store.integration.test.ts` |
| planning | job-scoped isolated checkout/store 上で Source Issue を claim 済みとして intake し、planning session を実行。`claimed → planning → accepted / awaiting-design / needs-human-review` をローカル store、operator progress を PostgreSQL に記録 | `apps/agentops/src/runner/adapter.ts`, `apps/agentops/src/intake/development-turn.ts`, `apps/agentops/src/intake/planning-enrichment.ts`, `apps/agentops/test/runner-adapter.test.ts` |
| conditional design | planning candidate が UI design authority を要求した場合だけ design resolution と deterministic acceptance gate を通す。不成立は human review へ fail closed | `apps/agentops/src/intake/development-turn.ts`, `apps/agentops/src/designflow/decision-gate.ts`, `apps/agentops/src/designflow/contract-consumer.ts` |
| implementation / PR | generator の隔離 worktree/branch で commit を作り、external work identity を検証して push、PR を作成または exact-correlated PR を再利用。`PRRevision(pr, head SHA)` を生成 | `apps/agentops/src/pipeline/execution/live.ts`, `apps/agentops/src/pipeline/execution/gate.ts`, `apps/agentops/src/pipeline/execution/worktree.ts`, `apps/agentops/src/pipeline/execution/work-identity.ts`, `apps/agentops/test/execution-worktree.test.ts`, `apps/agentops/test/external-work-identity.test.ts` |
| validation / review round | repository grader 後、current head の detached read-only worktree で perspective ごとの review を実行。local JSON store の `PrRevision.ordinal`, `EvalRun.attempt/perspective/headSha`, `AgentInvocation` と PostgreSQL release receipt に証拠を保持 | `apps/agentops/src/pipeline/execution/live.ts`, `apps/agentops/src/pipeline/execution/repository-pr.ts`, `apps/agentops/src/pipeline/execution/perspective-session.ts`, `apps/agentops/src/evidence/release-projection.ts`, `apps/agentops/test/runner-adapter.test.ts`, `apps/agentops/test/finding-lineage.test.ts` |
| repair / re-review | request changes を Repair Brief に正規化し、同じ PR branch に次 commit を作る。新 head は旧 approval を stale にし、全 perspective を再実行。process 内 loop は `maxRepairs + 1` で停止 | `apps/agentops/src/pipeline/execution/loop.ts`, `apps/agentops/src/pipeline/repair.ts`, `apps/agentops/src/domain/pr-lifecycle.ts`, `apps/agentops/test/repair-loop.test.ts`, `apps/agentops/test/pr-lifecycle-immutability.test.ts` |
| merge | current head の required perspective、grader/check、blocking thread、mergeability を fresh snapshot で再検証し、expected SHA 付き merge。release receipt の merge intent を先に durable 化 | `apps/agentops/src/pipeline/execution/pr-native.ts`, `apps/agentops/src/evidence/release-projection.ts`, `apps/agentops/test/pr-native-gate.test.ts`, `apps/agentops/test/release-projection.integration.test.ts` |
| release | GitHub の merged head、merge SHA、Issue completion、default branch reachability を観測し、release を `merged`、job/attempt/lease を terminal にする。親 Epic close は frozen Source Issue から冪等 reconcile | `apps/agentops/src/runner/adapter.ts`, `apps/agentops/src/runner/service.ts`, `apps/agentops/src/control-store/store.ts`, `apps/agentops/src/evidence/release-projection.ts`, `apps/agentops/test/release-receipt-store.integration.test.ts` |

### Dashboard / progress / lineage / merge の現状と不足

| 関心 | 既存実装 | 不足 |
| --- | --- | --- |
| 監視 repository 登録 | `apps/control-plane/internal/control/api.go`, `apps/control-plane/internal/control/store.go`, `apps/control-plane/internal/control/dashboard/{index.html,dashboard.js}` は PostgreSQL Registration の create/list/version-fenced update/disable/re-enable と command idempotency を持つ | create 時は canonical shape しか検証せず、GitHub App の到達性・repository access・required permission を表示しない。monitor/triage/credential broker は `AGENTOPS_MONITOR_REPOSITORIES`、runner credential は `AGENTOPS_RUNNER_REPOSITORIES` にも拘束され、durable Registration が単独の運転 SoT になっていない |
| Issue 進捗 | migration 14/15 の `development_progress_events`、`apps/control-plane/internal/control/store.go`、`apps/control-plane/cmd/agentopsctl progress`、dashboard の Issue section が durable history を表示 | event log の最新 timestamp を current とみなす。terminal job/release から canonical current state を投影せず、表示語彙も requested Kanban lane より粗い |
| review round | local store の `PrRevision.ordinal`, `EvalRun.attempt/perspective`, release review receipts は head-bound で再起動後も job state volume から復元 | PostgreSQL operator projection に round、perspective outcome、finding count、repair/re-review 関係が first-class field として無く、dashboard だけでは review round を復元できない |
| gate 滞留時間 | event の `occurred_at` と lease heartbeat はある | gate entered/left/deadline/SLA を durable に持たず、待機時間は導出も表示もされない。timeout policy も Registration ごとに設定できない |
| human escalation | planning ambiguity、stuck generator、review exhaustion は progress blocker/next gate と `needs-human-review` に写る | SLA 超過 escalation の one-shot identity、target SHA、evidence、required human action が無い。通知 dedup も無い |
| worktree / branch lineage | progress に worktree/branch/PR、release head に parent head、local PR revision に head lineage がある | review finding から分離した child issue/worktree/branch/PR の親 head、integration base、DAG、cycle/orphan guard が無い |
| merge 条件 | `apps/agentops/src/pipeline/execution/pr-native.ts` と release receipts が current expected SHA、全 review/check/thread、mergeability、merge intent/receipt を fail closed で検証 | child DAG を含む累積 branch の完了条件、全 child 統合後の current expected SHA による root merge は未実装 |
| release provenance / rollout | release receipt は consumer revision と runtime environment を保持し、`agentopsctl drain` は current attempt を保護 | dashboard/runner の同一 commit を operator view で比較できない。versioned staged rollout、health promotion、automatic rollback receipt が無い |

### 誤表示と取り残しの実装前証拠

1. `apps/control-plane/internal/control/store.go` の `DevelopmentProgress` と `Projections` は
   `occurred_at DESC, id DESC` の先頭 event を current にする。
2. terminal job に既存 progress event が一件でもあると migration 15 の terminal backfill 対象外になる。
   そのため最後の event が `generation/running` のまま job が `failed` になると、CLI/dashboard は badge/state
   だけ `failed` に上書きし、phase、step、next gate、since は古い running event を表示する。
3. lease expiry は有限 retry と terminal job failure を作るが terminal progress event は runner の live lease
   からしか書けない。crash path は canonical terminal projection を持たず、claimed label の解除または human action
   も operator view から一意に分からない。
4. intake local store の `claimed|planning` は job-scoped volume に残るが、operator current state はその state machine
   でなく progress event に依存する。runner crash/restart の間、claimed 表示を期限付き lease/recovery state に
   置き換える仕組みが無い。

実装前対象テストは
`go test ./apps/control-plane/internal/control ./apps/control-plane/cmd/agentopsctl` と
runner/service/release の Vitest が成功した。
PostgreSQL integration と Playwright dashboard は `AGENTOPS_TEST_DATABASE_URL` 未設定のため実行前チェックでは
skip / fail-fast になった。実装後は throwaway PostgreSQL を用意して migration/restart と headless E2E を実行する。

## 受け入れ条件

1. PostgreSQL Registration が監視・実行対象の唯一の repository SoT で、初期かつ唯一の enabled 対象が
   `mrbaron3/servo` である。dashboard 操作は idempotent で、duplicate/access/unreachable/configuration failure
   を区別する。
2. current Issue view は raw latest event でなく durable state machine、job/lease terminal outcome、release、review
   round、gate wait、escalation、lineage から一意に投影され、restart 後も同じ結果になる。
3. Kanban lane は `ready`, `intake/planning`, `design`, `implementation`, `review round N`, `repair`,
   `gate wait`, `human escalated`, `merge ready`, `released`, `failed` を区別する。
4. gate SLA 超過は target SHA と evidence を持つ one-shot escalation を作り、retry/lease recovery は有限である。
5. review finding は `in-change` または `separate-issue` に構造分類され、後者は source finding と親 branch/head を
   束縛した child DAG として exact parent head から隔離 worktree/branch を作る。child PR base は親 integration
   branch で、全 descendant の統合・累積 test/review 後だけ root を main へ一度 merge できる。
6. fake GitHub headless E2E、fake clock SLA、PostgreSQL migration/restart、branch DAG integration test が成功する。
7. dashboard と runner は同じ release commit provenance を表示し、drain-aware staged deployment と rollback 手順を
   runbook に持つ。

## 最初の縦切り

最初の変更は次を一つの restart-safe な縦切りとして行う。

1. PostgreSQL に canonical Issue execution projection、review round、gate observation/escalation を追加する。
2. raw progress + job/lease/release terminal facts を deterministic projector で Kanban lane へ畳み、terminal fact を
   stale running event より常に優先する。
3. monitor broker と runner credential の repository scope を durable enabled Registration から解決し、dashboard
   登録を実運転へ直結する。
4. dashboard を repository card 内の Issue list から repository 別 Kanban board へ拡張し、CLI も同じ projector を読む。

この縦切りを土台に gate SLA、review finding split、child DAG、staged deployment を順に追加する。

## 実装結果

| 受け入れ条件 | 実装結果 | 主な検証 |
| --- | --- | --- |
| durable Registration | migration 20 が fresh store に `mrbaron3/servo` 一件と完全な release policy を seed。monitor/triage/runner/GitHub token broker は claim 時の current enabled Registration だけを repository authority にする | control-store migration/restart、monitor broker、credential contract |
| canonical Kanban | migration 19 の head/review/gate fields、job/attempt/lease/release/escalation と未報告 queued/leased job を pure projector へ畳む。terminal release/failure は stale running event より優先 | Go fake-clock/unit/PG integration、Playwright |
| gate SLA | Registration ごとの timeout、one-shot `human_escalations`、advance/terminal resolution、target SHA/evidence/human action を実装 | 59秒/60秒 fake clock、restart projection |
| review round | migration 21 の round/perspective/finding tableへ start、各 perspective、verdict、finding を current head 単位で保存し、terminal evidence の書換えを拒否 | Zod/SQL strict validation、改ざん拒否、PG restart integration |
| separate issue DAG | finding disposition、deterministic marker、冪等 child Issue、exact parent head checkout、child PR base、descendant/direct-child/ancestry merge gate、cycle guardを実装 | fake GitHub、workspace drift、multiple/nested child、cycle、merge authorization test |
| staged self-update | clean Servo HEAD を provenance として control/dashboard/runnerへ同時注入。`deploy` が current job を drain 後に build/migrate/promoteし、`start` は dirty/stale/no-build を拒否 | Go provenance/topology test、runbook rollback boundary |

実装後の運用手順と確認コマンドは
[`docs/runbooks/servo-autonomous-pipeline.md`](../runbooks/servo-autonomous-pipeline.md) を正本とする。
