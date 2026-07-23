# Design delta

- live sampleの順序を`commit → push/create PR → detached Perspective reviews → panel`へ変更する。
- `runBoundedRepairLoop`へ既存PRの`startAttempt/initialRepairBrief`を追加し、process再起動時は
  保存済みheadからworktreeを再構成する。
- GitHub review threadはGraphQLからcurrent snapshotとして読み、P0/P1/blockerだけをblocking findingへ変換する。
