# Read-only reviewer workspace integrity 受け入れ要件

> D6で実測した「reviewerの依存確認がlockfileを更新し、健全なfindingsまでdirty checkoutとして
> 破棄された」失敗を閉じるFeature契約。reviewerのtest実行能力を残したまま、評価対象buildと
> evidenceの完全性を別々の境界で守る。

## 意図（roadmap-planner が定めた outcome）

- 機能: Read-only reviewer workspace integrity
- outcome（価値・なぜ今）: reviewer が依存関係の確認やテストを行っても評価対象 checkout を変更せず、
  lockfile 等への書込み事故で健全な review evidence が失われて needs-human-review になる D6 の
  false-escalation が再発しない。
- 計画の木リンク: feature=FEAT-012 epic=EPIC-06

## サブ機能一覧

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| RW-A | buildとreview workspaceの構造分離 | 高 |
| RW-B | evidence sidecar分離 | 高 |
| RW-C | environment/source mutation分類 | 高 |
| RW-D | 並行・late evidence互換性 | 高 |

## RW-A buildとreview workspaceの構造分離

**受け入れ基準**

- **[AC-REVWS-001] 不変条件: reviewerの実行は評価対象buildを変更しない**
  - Given generatorが確定したbuild commitと複数のPerspectiveがある
  - When reviewerが依存確認またはtestを実行する
  - Then 各reviewerはbuildのPerspective専用detached checkoutで実行され、generator worktreeと
    build commitの内容・参照は開始前後で不変である

## RW-B evidence sidecar分離

**受け入れ基準**

- **[AC-REVWS-002] 正常系: promptとfindingsはreview checkout外の専用sidecarで受け渡す**
  - Given Perspectiveごとのreview jobが準備される
  - When promptを発行しreviewerがfindingsを書き終える
  - Then promptとsentinelはそのPerspectiveだけのcheckout外directoryにあり、review checkoutの
    dirty判定や別Perspectiveのevidenceと混ざらず中央evalRootへ収集される

## RW-C environment/source mutation分類

**受け入れ基準**

- **[AC-REVWS-003] 回帰系: lockfileだけの環境副作用は帰属してfindingsを失わない**
  - Given reviewerが健全なfindingsをsidecarへ書き、依存確認で既知lockfileだけがdirtyになった
  - When orchestratorがreview結果を収集する
  - Then Perspectiveと変更fileをenvironmentChangesへ記録し、findingsを中央evalRootへ収集して
    falseなneeds-human-reviewを発生させない

- **[AC-REVWS-004] 異常系: sourceまたは設定変更を含むreview findingsは採用しない**
  - Given reviewerがfindingsを書いたが、checkoutでsource/config fileを変更した
  - When orchestratorがreview結果を収集する
  - Then 当該PerspectiveをtouchedCodeへ帰属しfindingsを中央へコピーせず、他のclean Perspectiveは
    独立して収集する

- **[AC-REVWS-005] 境界系: 未知のdirty fileを環境副作用へ黙って分類しない**
  - Given allowlistに無い生成物またはlockfileとsource changeが混在する
  - When mutationを分類する
  - Then 未知fileまたは混在jobはsource change violationとしてfail-closedに扱う

## RW-D 並行・late evidence互換性

**受け入れ基準**

- **[AC-REVWS-006] 並行/late系: Perspectiveごとのevidence identityとlate collectionを維持する**
  - Given 複数reviewerが並行実行され、一部がtimeout/stuck判定後にfindingsを書き終える
  - When phase-3 collectionを行う
  - Then evidence pathはissue/Perspectiveで衝突せず、collection時に存在する健全なfindingsは既存の
    late collection規則で採用され、missing/malformed evidenceは従来どおり昇格する

## 非機能要件

- 決定論: 同じdirty file集合は順序に関係なく同じenvironment/source分類になる。
- fail-closed: 明示した環境artifact以外を無視しない。
- 可観測性: 許容した環境副作用もPerspectiveとfile名をlog/resultへ残す。
- 並行安全性: reviewer間でprompt、sentinel、findings pathを共有しない。
- 互換性: liveness、late findings、malformed evidence昇格、source edit guardを弱めない。

## レッドライン

- reviewerをgenerator worktreeで起動しない。
- arbitrary dirty fileやpackage manifestを環境副作用として無視しない。
- dirty判定を通すためにreview findingsをsource treeへ書かせない。
- source/config変更を含むreview findingsを採用しない。
- test実行を全面禁止してreview品質を下げない。
- missing/malformed findingsをapproveへ補正しない。
