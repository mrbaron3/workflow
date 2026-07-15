# Idempotent GitHub Issue polling and claim 受け入れ要件

## 意図

- 機能: Idempotent GitHub Issue polling and claim
- outcome: 明示的にreadyなGitHub Issueを決定論watcherが発見・一度だけclaimし、repository＋issue identity・
  原文snapshot・状態をstoreに残す。重複pollや再起動は二重取込を生まない。
- 計画の木リンク: feature=FEAT-016 epic=EPIC-08

## 受け入れ基準

- **[AC-GHINTAKE-001] openかつready labelを持つIssueだけを発見する**
  - Given repositoryにopen/closed、ready有/無のIssueが混在する
  - When watcherがpollする
  - Then openかつ設定ready labelを持つIssueだけをnumber昇順でclaim対象にする

- **[AC-GHINTAKE-002] repository＋numberと原文snapshotを耐久保存する**
  - Given未取込のready Source Issueがある
  - When初回claimを行う
  - Then provider/repository/numberのidentity、title/body/url/labels/sourceUpdatedAtの初回snapshot、claimed状態を保存する

- **[AC-GHINTAKE-003] duplicate poll/restartで二重取込しない**
  - Given同じSource Issueがclaimed済みでrunner一覧に再出現する
  - When同一processまたはstore再読込後にpollする
  - Then IntakeRecord/counter/external claim回数を増やさず既存identityを返す

- **[AC-GHINTAKE-004] external claim失敗をstore-firstで再試行できる**
  - Given初回external label更新が失敗する
  - Whenpollし、その後同じstoreで再pollする
  - Then初回snapshotはclaim-pendingで残り、再pollは同recordを使ってexternal claimだけ再試行しclaimedへ進む

- **[AC-GHINTAKE-005] 同numberでもrepositoryが違えば別identityになる**
  - Givenowner/repo-a#42とowner/repo-b#42がreadyである
  - Whenそれぞれ別のOrganization Storeでclaimし、またclaim済みstoreのconfigだけを別repositoryへ変える
  - Thenkeyは衝突せず各storeで独立し、既存storeへの異repository混入は書込み前に拒否される

- **[AC-GHINTAKE-006] claimed後のSource編集で初回原文を上書きしない**
  - Givenclaimed済みIssueのtitle/body/labelsがGitHub側で更新される
  - When再pollする
  - Then初回Source Snapshotを保持し、更新値でlast-write-winsしない

## レッドライン

- ready label無しIssueをtitle/bodyから推測取込しない。
- 粗いbodyを直接IssueContractとしてexecutionへ流さない。
- external claim成功を先に行ってstore記録を失う順序にしない。
- title/bodyをdedup identityに使わない。
- GitHub側をSoTとしてstore claim recordを上書きしない。
