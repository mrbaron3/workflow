# Design delta

- live sampleの順序を`commit → push/create PR → detached Perspective reviews → panel`へ変更する。
- `runBoundedRepairLoop`へ既存PRの`startAttempt/initialRepairBrief`を追加し、process再起動時は
  保存済みheadからworktreeを再構成する。
- GitHub review threadはGraphQLからcurrent snapshotとして読み、P0/P1/blockerだけをblocking findingへ変換する。
- repository reconciliationで対象baseのsame-repository Open PRを列挙し、外部PR番号をdedup keyとして
  synthetic review work unitへupsertする。Webhook payloadはwake signalに留め、pollも同じGitHub snapshotを読む。
- repository-discovered PRはcurrent headのdetached worktreeを制限付きreviewする。repository-authored headは
  attacker-controlledなので、request_changesでもoperator credential/push権限を持つ既存Generator repair
  laneへは送らない。外部で修正pushされた新headを次turnでfresh reviewする。
- Draftはreview対象だがmerge gateではpendingとし、fork headは書込み権限を推測せず自動管理対象外にする。
