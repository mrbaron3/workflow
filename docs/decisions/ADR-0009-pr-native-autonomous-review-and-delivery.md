# ADR-0009: PR の head revision を自動レビュー・修正・merge の耐久単位にする

- 状態: 採択・吸収済み（2026-07-23。実装と grounded run は未完了）
- supersedes:
  - ADR-0006 G1 の「パネル承認後にPRを作る」
  - ADR-0006 G1/G3 の「人間mergeだけがrelease承認」
- preserves:
  - 観点ごとの独立Reviewer Session
  - hard gate before score
  - store＝SoT、GitHub＝投影
  - `needs-human-review`＝自動処理不能時のescape hatch

## 文脈

PR #8では、ローカルの検証結果とGitHub上のレビュー結果が別の時間軸に存在した。修正前head
`b80a3ec`へP1が付いた後、修正head `5e263a8`はテストを通ったが、最新headに対する再レビュー結果の
到着を決定論的に追跡する器官が無かった。現行実装はパネル承認後にだけPRを作り、`pollGate`は
`open|closed|merged`しか読まないため、PR上のP1・review dismissal・head更新が承認を無効化しない。

これは「人間がGitHub IssueへWHATを書けば、AIがPR上でレビューと修正を繰り返し、通過時にmergeして
次taskへ進む」という目標像と逆向きである。

## 決定

### PR-first と revision identity

- 初回Generatorがbuild commitを作った直後、LLM観点レビューより先にGitHub PRを作る。
- 評価単位を `(prId, headSha)` の **PR Revision** とする。
- EvalRun、Reviewer Invocation、finding、check結果は必ず同じhead SHAへ束縛する。
- pushでhead SHAが変わった時点で旧revisionの承認はstaleとなり、merge資格へ寄与しない。

### レビュー・修正ループ

- 現在headをPerspectiveごとの独立Reviewer Sessionがdetached checkoutでレビューする。
- deterministic grader、必須GitHub checks、設定された外部review threadを同じrevision gateへ集約する。
- P0/P1、blocker、`request_changes`、必須check failure、missing evidenceのどれか1つでもあれば
  current revisionは不承認。
- findingsをRepair Briefへ正規化し、同じPR branchへ修正commitをpushする。新headを全観点で再評価する。
- 1 process turnの試行数は有限に保つが、未解決workはstoreから次turnへresumeする。無限loopを
  process内で作らず、同じ失敗の反復・曖昧なWHAT・provider停止だけを`needs-human-review`へ昇格する。

### 自動mergeと次task

merge直前にGitHubからhead SHA・unresolved blocking threads・必須checks・mergeabilityを再取得し、次を
すべて満たす場合だけexpected head SHA付きでmergeする。

```text
全必須観点 approve(current head)
AND unresolved blocking findings = 0
AND required checks = green
AND mergeable
AND head SHA unchanged
```

merge成功をstoreへ`released`として記録し、依存を解除して同じwatch loopの次taskへ進む。1 Source Issueが
複数Store Issueへ分割された場合、各子PRは`Refs`に留め、全子Issueがreleasedになった集約点だけがSource
Issueを閉じる。

### 人間判断点

通常のapprove/mergeを人間判断点にしない。人間はWHATの確定、policy変更、`needs-human-review`の解消、
明示overrideだけを担う。人間overrideは対象head・理由・時刻をInterventionとして耐久記録する。

## 帰結

- ＋ PRのdiff・review・check・revision履歴が実際の自動ループになる。
- ＋ 「承認済みなのに同じheadへ未解決P1がある」false-passを構造的に禁止できる。
- ＋ 修正pushが古い承認を再利用しない。
- − GitHub API失敗・review bot遅延が新しいliveness面になる。durable stateとreconciliationが必要。
- − ADR-0006のhumanVerdict収穫は通常mergeでは自動判定になる。人間override時だけcalibration labelを得る。

## system層への吸収

| premise | 吸収先 |
| --- | --- |
| PR Revisionとhead SHA束縛 | `LANG-execution-020` / `DOM-execution-013` / `DATA-execution-010` |
| current revision gate | `ARCH-execution-020` |
| 修正push後の全観点再レビュー | `ARCH-execution-021` |
| atomic auto-mergeとqueue継続 | `ARCH-execution-022` |
