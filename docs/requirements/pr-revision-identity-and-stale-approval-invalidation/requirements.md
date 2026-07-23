# PR revision identity and stale-approval invalidation 受け入れ要件

## 意図

- 機能: PR revision identity and stale-approval invalidation
- outcome: review/check/Invocation/EvalRunをcurrent PR head SHAへ束縛し、push後に旧承認を再利用しない。
- 計画の木リンク: feature=FEAT-022 epic=EPIC-11

## 受け入れ基準

- **[AC-PRREV-001] `(prId, headSha)`を一意なrevisionとして耐久保存する**
  - Given同じPR headをpollまたはWebhookで複数回観測する
  - Whenrevisionをobserveする
  - Then同じ`PRRevision`を再利用し、ordinalを重複採番しない

- **[AC-PRREV-002] head更新で旧revisionをstaleにする**
  - Given旧headがapproved
  - When異なるcurrent head SHAを観測する
  - Then旧rowをstaleにし、新rowだけを`PR.currentRevisionId`にする

- **[AC-PRREV-003] review証拠をrevisionへ束縛する**
  - GivenPerspective reviewとagent invocation
  - When保存する
  - Then`revisionId/headSha`を保持し、別SHAのapproveをcurrent gateへ数えない

## レッドライン

- branch名、PR番号、attempt番号だけをrevision identityにしない。
- stale revisionのapproveをcurrent headへ継承しない。
