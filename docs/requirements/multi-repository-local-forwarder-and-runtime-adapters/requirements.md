# Multi-repository local forwarder and runtime adapters 受け入れ要件

## 意図

- 機能: Multi-repository local forwarder and runtime adapters
- outcome: registrationごとのGitHub forwarderを監督し、OS非依存coreから固定AgentOps/Orca adapterへ配送する。
- 計画の木リンク: feature=FEAT-026 epic=EPIC-12

## 受け入れ基準

- **[AC-WHRT-001] enabled registrationごとにforwarderを1つ監督する**
  - Given複数repository registration
  - Whenreconcileする
  - Thenenabled repoだけに1 childを起動し、event変更/disableで旧childを停止する

- **[AC-WHRT-002] 異常終了したforwarderを再起動可能にする**
  - Givenchildがerror/exitした
  - Whennext reconcileを行う
  - Then同registrationを再起動し、daemon自体は停止しない

- **[AC-WHRT-003] AgentOpsをworkspace単位の固定entry pointでwakeする**
  - Given`agentops` consumer registration
  - Wheneventまたはpoll reconciliationが届く
  - Thenworkspaceのintake repository一致を検証し、固定`github-turn`をrepo単位single-flightで実行する

- **[AC-WHRT-004] 既存Orca同期を型付きadapterで維持する**
  - Givenmerged PRまたはnon-deleted branch push
  - When`orca-worktree-sync` consumerへ配送する
  - Then固定script pathへ`pr-merged`または`push`引数だけを渡し、registrationからcommandを受け取らない

## レッドライン

- repository registrationへ任意commandを保存・実行しない。
- Webhookだけに依存してpoll reconciliationを止めない。
- macOS固有launchd/osascriptをcore runtimeへ持ち込まない。
