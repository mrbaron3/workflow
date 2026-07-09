# 依存順複数 issue drive 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「依存を持つ複数 issue が、依存順を守って・
> ブロックを隠さず・人手の再登録なしに drive される」という観測可能な性質。guard/loop の
> 関数分割・ブロック報告のデータ形は実装の裁量。
>
> **前提（現状の欠け・A2 ギャップ）**: `Issue.dependsOnIssues` は schema・spawn の key→id
> 再写像・spawn 時の design lint（未知 key と循環の拒否 — 検証済みの既存挙動）まで存在するが、
> **実行ガード（pollable）と drive ループは依存を一切見ない** — 宣言はできるのに尊重されない。
> 「roadmap→epic→issue」の下流トレースが 1 issue 規模で止まっている（NORTH_STAR_PLAN A2）。
> AC-DAG-004 は既存 lint の**後方互換 AC**（④ AC-REGMT-004 と同じ型・実装前 green が正しい形）
> — guard/loop を依存対応にする本変更が spawn 衛生を退行させないことを pin する。
>
> **人間ゲートとの関係（重要）**: live 経路の issue は panel 承認でも自動 released に
> ならない（DOM-execution-007・審査は人間の判断点）。したがって live の依存チェーンは
> 「A を drive → 人間が A を released → 次の turn が B を自動で拾う」という **turn 跨ぎ**で
> 進む — 本 spec はそれを変えない。1 回の呼び出しでチェーンが依存順に完走することの決定論
> 検証は mock coordinator 経路（approve→自動 released の demo 経路）で行う。
>
> **参照する固定制約**: `DOM-execution-006`（opt-in 既定非処理の実行ガード）／
> `ARCH-execution-002`（scoping guard）／`ARCH-execution-015`（never-silent）。
> dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Dependency-ordered multi-issue drive
- outcome（価値・なぜ今）: dependsOnIssues が実行ガードで尊重され、1 spec から生えた依存チェーン（2+ issues）が依存順に自動 drive される。未 released の依存によるブロックは理由付きで可視（never-silent）。
- 計画の木リンク: feature=FEAT-007 epic=EPIC-03

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| DAG-A | 依存ブロックの尊重と可視化（guard） | 高 |
| DAG-B | 依存順の自動駆動（解除・チェーン完走） | 高 |
| DAG-C | spawn 衛生（未知 key・循環の loud 拒否） | 中 |

## DAG-A 依存ブロックの尊重と可視化

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・poll/dispatch）
- 何を: 未 released の依存を持つ issue を generator へ渡さず、なぜ渡さないかを見えるようにする
- なぜ: 依存先の成果（API・schema）が無いまま drive すると、無駄な attempt か偽の実装が生まれる。
  一方で黙って skip すると「なぜ進まないのか」が人の頭にしか無くなる（never-silent 違反）

**受け入れ基準**

- **[AC-DAG-001] 正常系: 未 released 依存を持つ issue はブロックされ、理由が可視**
  - Given ai-managed（contract-drafted・assigned）の issue B が dependsOnIssues に issue A を持ち、
    A が released でない（planned / 実行中 / needs-human-review / closed のいずれでも）
  - When 実行ガードが poll する
  - Then B は pollable に現れず generator セッションは生成されない。ブロックの事実は
    「B がどの依存（A）のどの状態を待っているか」を含む形で機械可読に報告され、
    live turn のログにも現れる（黙って消えない）。dependsOnIssues が空の issue の挙動は
    従来と完全に同一（後方互換）

## DAG-B 依存順の自動駆動

**ユーザーストーリー**

- 誰が: 進行管理役・人間（WHAT の分解者）
- 何を: 依存チェーン（2+ issues）を、人手の再登録なしに依存順で消化する
- なぜ: 「1 spec = 1 issue」の但し書きを消すのが M2 の出口。依存の解除に人手の摘み直しが
  要るなら、複数 issue 分解は自律でなく手動オーケストレーションになる

**受け入れ基準**

- **[AC-DAG-002] 正常系: 依存が released になれば自動で解除される**
  - Given AC-DAG-001 の状態（B が A を待ってブロック中）
  - When A が released になり、次の poll が走る
  - Then B は追加の人手（再 assign・再登録）なしに pollable へ現れ、以後のループが drive する

- **[AC-DAG-003] 正常系: チェーンが依存順に完走する（決定論経路）**
  - Given 1 spec から生えた依存チェーン A ← B ← C（B は A に、C は B に依存）が全て
    contract-drafted で、approve すれば自動 released になる決定論（mock）経路
  - When ループを 1 回呼ぶ
  - Then A → B → C の依存順で drive され 3 件とも released に至る。どの issue も自分の依存が
    released になる前に generator へ渡らない（適格性はチェーン進行に伴い再評価される —
    呼び出し冒頭のスナップショットで B/C を取り逃さない）

## DAG-C spawn 衛生（後方互換）

**ユーザーストーリー**

- 誰が: 人間（issue 分解の著者）・進行管理役
- 何を: manifest の依存宣言の誤り（typo・循環）が spawn 時点で止まる**現行の保証を、guard/loop
  が依存を尊重するようになった後も保つ**
- なぜ: 依存が「尊重される」ようになった瞬間、未知 key は「存在しない issue を待つ」沈黙の死、
  循環は「全員が互いを待つ」沈黙の死へ**昇格**する — 既存 lint がこの機能の安全前提になる

**受け入れ基準**

- **[AC-DAG-004] 異常系: 未知の依存 key と循環依存は spawn が loud に拒否する**
  - Given issues.yaml manifest の dependsOnIssues に (a) manifest 内にも store にも存在しない
    key、または (b) manifest 内で循環を成す宣言がある
  - When spawn-issues を実行する
  - Then どちらも理由付きで loud に拒否され、issue は 1 件も spawn されない（部分 spawn を
    残さない）。既知 key の id 再写像・既存 issue id の直接参照という現行の正常系は不変

**非機能要件**

- 決定論: ブロック判定・依存順は store の内容だけから決まる（guard は純関数のまま）。
- 可観測性: ブロック中の issue と待ち先は status / ループログから監査できる。
- 互換性: dependsOnIssues が空（既定）の issue は従来挙動と完全同一。schema 変更なし。

**完了条件**

- 自動テスト: ブロック＋可視化／自動解除／チェーン完走（mock）／spawn 拒否（未知 key・循環 —
  後方互換につき実装前から green が正しい）各 1 以上。
- 運用観測（released 後・grader 対象外）: FEAT-008 の spec を依存を持つ 2+ issues に分解して
  drive し、live 経路の turn 跨ぎ解除（A released → 次 turn で B 自動 pickup）を grounded で
  観測する（M2 出口・A2 の完了条件）。

## レッドライン

> 実装が絶対にしてはならないこと。

- `test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 人間ゲートを跨いで自動 release しない: 依存解除を早めるために live 経路の released を
  自動化しない（DOM-execution-007 不変・判断点は消さない）。
- ブロックを状態遷移にしない: ブロック中の issue の status は変えない（contract-drafted の
  まま・dispatch されないだけ）。ブロックの発明的な新 status を増やさない。
- opt-in ガードを緩めない: 依存が満たされていても、ai-managed でない issue は従来どおり
  拾わない（DOM-execution-006 不変）。
- 合格基準（既存テスト）を弱体化しない。
