# Atomic automatic merge and queue continuation 受け入れ要件

## 意図

- 機能: Atomic automatic merge and queue continuation
- outcome: current headの全ゲート通過時だけexpected SHA付きでmergeし、release・Source Issue集約・次taskへ進む。
- 計画の木リンク: feature=FEAT-024 epic=EPIC-11

## 受け入れ基準

- **[AC-PRAUTO-001] current revisionの全必須証拠を同時に要求する**
  - Givencurrent headのPerspective/check/thread/mergeability snapshot
  - WhenRevision Gateを評価する
  - Then全Perspective approve、blocking finding/thread 0、required check green、mergeableだけがapprovedになる

- **[AC-PRAUTO-002] expected head SHA付きでmergeする**
  - GivenRevision Gate approved
  - Whenmergeする
  - Then`--match-head-commit <currentSha>`相当を使い、headが変われば失敗する

- **[AC-PRAUTO-003] merge成功後だけreleasedにする**
  - GivenGitHub merge command
  - When成功する
  - ThenPR/revisionをmerged、Issueをreleasedにし、次pollで依存taskをqueueへ入れられる

- **[AC-PRAUTO-004] 分割Source Issueを全子release後だけ閉じる**
  - Given1 Source Issueが複数Store Issueへ分割された
  - When最後の子がreleasedになる
  - ThenSource Issueを1回closeし、失敗を保存してreconciliationでretryする

## レッドライン

- `--admin`でbranch protectionを迂回しない。
- pending/unknownをpassとして扱わない。
- 1子PRのmergeで分割Source Issueをcloseしない。
