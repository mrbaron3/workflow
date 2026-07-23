# PR-native review and repair loop 受け入れ要件

## 意図

- 機能: PR-native review and repair loop
- outcome: PR作成後のcurrent headを独立観点でreviewし、blocking指摘を同branchへ修正pushしてfresh reviewする。
- 計画の木リンク: feature=FEAT-023 epic=EPIC-11

## 受け入れ基準

- **[AC-PRLOOP-001] 最初のPerspective review前にPRを作る**
  - GivenGeneratorが初回build commitを作った
  - When評価へ進む
  - ThenbranchをpushしてPRを作り、そのhead SHAをreview対象にする

- **[AC-PRLOOP-002] approve付きP1相当findingを拒否する**
  - GivenReviewer outputがapproveだがblockerまたはmajor findingを含む
  - Whenpanelを集約する
  - Then`request_changes`へ正規化しRepair Briefへ渡す

- **[AC-PRLOOP-003] 同じPR branchを修正し全観点を再実行する**
  - Givencurrent revisionがrequest_changes
  - Whenrepair attemptを実行する
  - Then既存worktree/branchを修正し、新headをpushして新revisionへ全Perspective runを保存する

- **[AC-PRLOOP-004] 外部P0/P1 threadを次turnでrepairへ戻す**
  - GivenGitHub current headに未解決P0/P1 thread
  - WhenWebhookまたはpoll reconciliationが実行される
  - Then本文/path/lineをdurable gate snapshotへ保存し、同PRのfresh attempt用Repair Briefにする

## レッドライン

- PR作成前のreview結果だけでGitHub PRをmerge可能にしない。
- 修正push後に旧review runを再利用しない。
- approve tokenでP0/P1相当findingを隠さない。
