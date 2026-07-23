# ADR-0010: Webhookを即時トリガー、pollをreconciliationとする複数repo制御面を置く

- 状態: 採択・吸収済み（2026-07-23。実装と grounded run は未完了）
- supersedes:
  - ADR-0006 G1 の「webhookを建てない」
  - ADR-0008 I3 の「webhookを建てない」
- preserves:
  - store＝SoT
  - 決定論orchestrator
  - pollingによる取りこぼし回収

## 文脈

`/Users/yu/Company/Development/bin/octolink-webhook-daemon.py` は `gh webhook forward` を使い、
`fopen-hub/octolink`の`pull_request,push`をローカルへ中継してOrca同期を起動する実用実装である。
一方でrepo・port・events・consumerが固定、queueはmemoryのみ、delivery dedupと再実行履歴がなく、
launchd/macOS通知とOrca repo IDへ運用が結合している。

AgentOps側はIssue/PRをpollするため、イベント到着から着手までの遅延があり、PR review/comment/checkを
revision loopへ戻す入口も無い。Webhookだけへ置換するとsleepや一時切断で取りこぼすため、両者の役割を
分ける必要がある。

## 決定

### Webhookはtrigger、pollはreconciliation

- Webhookはworkを即時にwakeするヒントであり、最終状態のSoTではない。
- 受信payloadから直接merge/releaseを決めず、workerがGitHubのcurrent snapshotを再取得して処理する。
- 周期pollを残し、未配送・重複・順序逆転・daemon停止中のイベントを回収する。

### Durable Event Inbox

- ingressはsignature（public mode）またはloopback forwarder境界（local mode）を検証する。
- `X-GitHub-Delivery`をidempotency keyとし、payloadとmetadataをdurable inboxへ保存してから2xxを返す。
- deliveryは`pending|processing|processed|ignored|failed`とattempt/errorを保持し、GUIから再実行できる。
- 同じdeliveryの再送は新しいworkを作らず、既存recordを返す。

### Repository Registryとrouter

- `owner/name`、enabled events、consumer、workspace/store binding、ready label、base branchをrepo registrationとして
  耐久管理する。
- 1 daemonが複数repoを扱い、registrationにないpayloadは理由付き`ignored`にする。
- consumerはPublished LanguageのNormalized GitHub Eventだけを受け、生payloadやforwarder processを知らない。
- 最初のconsumerは`agentops`と`orca-worktree-sync`。Octolink固有同期は後者のadapterへ移す。

### RuntimeとGUI

- coreはOS非依存。`gh webhook forward` process managerはlocal ingress adapter、launchdはmacOS service adapter。
- remote ingress/GitHub App、systemd等を後から追加してもinbox/router/consumerは不変。
- 既定listenは`127.0.0.1`。ローカル管理GUIからrepo追加・有効化、events/consumer設定、health、
  delivery履歴・失敗理由・再実行を扱う。
- GUIは任意commandを保存・実行しない。consumerは列挙型adapterのみ。

## 対象イベント

- `issues`: opened/labeled/reopened
- `pull_request`: opened/synchronize/reopened/closed
- `pull_request_review`: submitted/dismissed
- `pull_request_review_comment`
- `check_run` / `check_suite`
- `push`
- `issue_comment`（明示commandを採用する場合のみ）

## 帰結

- ＋ Issue着手・PR revision更新・review/check到着が即時にloopへ戻る。
- ＋ 複数repoをGUIで追加し、OctolinkとAgentOpsを同じtransport上で運用できる。
- ＋ poll fallbackによりWebhookのat-most-once/順序不定を正しさへ持ち込まない。
- − Webhook secret、delivery retention、forwarder再起動、multi-process書込みが新しい運用責務になる。
- − 既存Python daemonを直接巨大化せず、汎用core＋consumer adapterへ段階移行する必要がある。

## system層への吸収

| premise | 吸収先 |
| --- | --- |
| delivery/inbox/idempotence | `LANG-webhook-001..003` / `DOM-webhook-001` / `DATA-webhook-001..002` |
| repository registry/router | `DOM-webhook-002` / `ARCH-webhook-002` / `DATA-webhook-003` |
| trigger＋reconciliation | `ARCH-webhook-001` / `ARCH-webhook-003` |
| local forwarder/GUI/runtime adapter | `ARCH-webhook-004..006` |
