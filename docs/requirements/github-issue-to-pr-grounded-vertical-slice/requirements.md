# GitHub Issue-to-PR grounded vertical slice 受け入れ要件

## 意図

- 機能: GitHub Issue-to-PR grounded vertical slice
- outcome: 実remote上のready Issueがwatcher→planning→store→guard→drive→異種provider panel→GitHub PRまで進み、
  再起動を挟んでも重複せず、HOW介入0と証拠付き判定を計器で示す。
- 計画の木リンク: feature=FEAT-018 epic=EPIC-08

## 受け入れ基準

- **[AC-GHSLICE-001] 1 development turnが入口から既存queue driveまで順序固定で進む**
  - Givenready GitHub Issue、valid planning output、live drive依存がある
  - Whendevelopment turnを実行する
  - Thenclaim→planning invocation→trace gate→pollable Issue→existing driveの順に進み、各artifactをstoreへ残す

- **[AC-GHSLICE-002] planning sessionも独立workspace/provider route/liveness契約を使う**
  - Givenplanning routeがClaudeまたはCodexである
  - Whenproduction planning runnerを起動する
  - Thenprovider adapterを使うdetached workspaceとsidecar outputで動き、source edit/stuck/timeoutをfail-closedに返す

- **[AC-GHSLICE-003] rejected planningは実装・PRへ進まない**
  - Givenambiguityまたはtrace不正のplanning output
  - Whendevelopment turnを実行する
  - Thenintakeはneeds-human-reviewで止まり、そのsource由来Issueはpollable/drive/PRに現れない

- **[AC-GHSLICE-004] restart/duplicate pollでもsourceごとのplanningとIssueを一度だけ作る**
  - Given各段のstore artifactが一部または全部存在する
  - When同じturnを再実行する
  - Then存在するclaim/enrichment/Issueを再利用し、planner再起動・Issue重複・external claim重複を生まない

- **[AC-GHSLICE-005] output PRと評価をsource/providerへtraceできる**
  - Givenaccepted IssueがpanelとGitHub gateを通る
  - When監査する
  - ThenPR→Issue→intake Source Snapshot、EvalRun→Perspective AgentInvocation→provider/modelを辿れる

- **[AC-GHSLICE-006] remote/providerが利用不能でも沈黙・偽成功しない**
  - GivenGitHub/interactive provider/gradersのいずれかが失敗する
  - Whenturnを実行する
  - Then既存store-first/liveness/needs-human-review契約で停止またはerrorを顕在化し、released/PRを捏造しない

## レッドライン

- intake専用の第二drive/panel/gateを作らない。
- planning output検証前にgeneratorを起動しない。
- restart時に同じSource Issueのplannerを無条件再起動しない。
- fake integration結果を実remote grounded runとして報告しない。
- GitHub/API/provider失敗をreleasedへ補正しない。
