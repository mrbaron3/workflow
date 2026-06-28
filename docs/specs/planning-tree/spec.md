# 計画の木（roadmap → feature → spec spawn）配線 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth（オーサリング SoT）。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「製品ゴールを起点に、計画の木（roadmap → epic → feature）を
> 永続し、各 feature を著述可能な spec へ materialize するまでの、**成果物の観測可能な性質とゲート挙動**」。
> 計画の木の**スキーマ**（Feature/Epic/Spec の形・ID 形式・store 形・取込/spawn の関数）は本 spec に埋めない。
> それは **system 層 data-model** が定義する（greenfield 初回は未整備のため **前方参照**・AC-PLAN-008）。
> 署名 spec の slice/issue 分解は to-detail-design の領分（本 spec の範囲外）。
>
> **meta-feature の層分け**: 本機能はハーネス自身の機構（計画の木）を作る。形式（schema/ID）は system 層へ、
> **プロセスとゲート挙動は本 spec へ**と層を分ける。本 spec の AC が語るのは「取込が何を通し何を落とすか」
> 「spawn が何を産むか」「再取込が何を保全するか」であって、「Feature とは何の型か」ではない。
>
> **参照する固定制約**: [NORTH_STAR](../../NORTH_STAR.md)（状態は監査可能・証拠が蓄積される）／
> [DOC_LIFECYCLE](../../_meta/DOC_LIFECYCLE.md)（計画の木＝delta/intent、署名 spec は永続ログ＝source、catalog は派生）／
> [DOC_TAXONOMY](../../_meta/DOC_TAXONOMY.md) §2本の木（feature＝計画の木の葉、spec で system の木と交わる）／
> 既存オーサリング層（spec の署名＝contract-approved・SpecState・ApprovedSpecRef）。
>
> **チャットで指摘（自動採点不能）**: 分解の「良さ」（feature の切り出しが適切か・順序が妥当か）は
> roadmap-planner の判断であり契約化できない。別票に分けず、必要時にチャットで人間に指摘する。

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。相互依存・水平な処理段でよい。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| PLAN-A | roadmap 取込（計画の木の永続・AC 不在の強制） | 高 |
| PLAN-B | spec spawn（1 Feature = 1 spec dir・著述 stub 生成） | 高 |
| PLAN-C | 整合ゲート（roadmap への受け入れ基準混入を拒否） | 高 |
| PLAN-D | 冪等 re-plan とトレーサビリティ（additive・署名の保全） | 中 |

## PLAN-A roadmap 取込

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）と、製品ゴールを分解する roadmap-planner
- 何を: 製品ゴールから分解された roadmap（epic 群と、各 epic の feature 群）を、計画の木として永続する
- なぜ: 「Todo アプリを作りたい」のような製品スケールの要求を 1 つの巨大 spec にせず、署名可能な
  capability（=feature）まで分解した状態を、監査・resume 可能な形で持つため（北極星: 状態は人の頭でなく証拠に）

**事前条件**

- 製品ゴールの分解（どの feature か・順序・なぜ今か）は roadmap-planner が済ませている（本機能は分解結果を
  取り込むのであって、分解の良し悪しは問わない）。
- **system 層 data-model（計画の木のスキーマ）への前方参照**: Roadmap/Epic/Feature/Spec の形式・ID 体系・
  リンクの形は system 層が定義する。greenfield 初回は未整備のため seed 待ち（design 層が署名前に seed する
  順序に従う・AC-PLAN-008）。本ファイルに schema を埋め込まない（レッドライン）。

**受け入れ基準**

- **[AC-PLAN-001] 正常系: 分解された roadmap が計画の木として永続する**
  - Given 製品ゴールを epic 群に分解し、各 epic が feature 群（題目と outcome＝なぜ今／価値を持つ。受け入れ
    基準は持たない）を含む roadmap がある
  - When その roadmap を取り込む
  - Then 計画の木に当該 epic 群と feature 群が現れ、各 feature はちょうど 1 つの epic に、各 epic は roadmap に
    リンクされ、**いかなる feature にも受け入れ基準は保存されていない**

- **[AC-PLAN-002] 境界: outcome 不在の feature/epic を拒否する**
  - Given outcome（価値・なぜ今）が空の feature、または outcome の無い epic を含む roadmap がある
  - When 取り込みを試みる
  - Then 取り込みは拒否され（"No epic without a stated outcome" の契約化）、計画の木は変化しない

## PLAN-B spec spawn

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）
- 何を: 計画の木の各 feature を、著述可能な spec（spec dir ＋ 追跡される spec state）へ materialize する
- なぜ: feature（intent）と spec（著述・署名対象）を 1:1 で結び、以降 to-spec が各 spec を著述・人間が署名できる
  起点を、決定的に用意するため

**事前条件**

- 取り込み済みの feature が存在する（PLAN-A）。
- spec の著述本体は to-spec の領分。本機能が産むのは「空の著述 stub」であって受け入れ基準ではない。

**受け入れ基準**

- **[AC-PLAN-003] 正常系: 各 feature がちょうど 1 つの spec を得る**
  - Given まだ spawn されていない取り込み済み feature 群がある
  - When spawn する
  - Then 各 feature にちょうど 1 つの spec dir が生成され、追跡される（未署名の）spec state が登録され、feature は
    その spec を参照する。spec dir には著述可能な stub が置かれる（**受け入れ基準はまだ含まない**）

- **[AC-PLAN-004] 境界: 同名になりうる feature でも spec は一意・排他**
  - Given 題目から同一の dir 名になりうる 2 つの feature がある
  - When spawn する
  - Then それぞれ別個の spec dir を得（衝突しない）、各 spec state はちょうど 1 つの feature に対応する
    （1 spec を 2 feature が共有しない）

- **[AC-PLAN-005] 耐障害性: spawn は冪等で、既存の著述を上書きしない**
  - Given 既に spawn 済みの feature 群がある
  - When 再度 spawn する
  - Then spec dir も spec state も重複生成されず、既存の spec 内容（著述途中・署名済みを含む）は上書きされない

## PLAN-C 整合ゲート

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）
- 何を: 受け入れ基準が roadmap 側に混入することを取込時に拒否する
- なぜ: 受け入れ基準は人間が spec に著述し署名するもの（オーサリング層）。roadmap に AC を焼くと、署名・
  ドリフト検知・「source(spec)＝永続ログ／catalog＝派生」の原則がすべて崩れる（DOC_LIFECYCLE と矛盾）

**受け入れ基準**

- **[AC-PLAN-006] 異常系: 受け入れ基準入りの roadmap を拒否し、何も永続しない**
  - Given いずれかの epic/feature に受け入れ基準（または完成した issue 契約）がインラインで含まれる roadmap がある
  - When 取り込みを試みる
  - Then 取り込みは拒否され、違反箇所を示すエラーが出て、計画の木には何も永続されない（受け入れ基準は
    著述・署名された spec にのみ存在しうる）

## PLAN-D 冪等 re-plan とトレーサビリティ

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）
- 何を: roadmap の再取込を additive に行い、計画の木の鎖（north-star → epic → feature → spec → 署名 AC）を
  双方向に辿れる状態に保つ
- なぜ: 機能追加要求が来るたび木が壊れず積み上がり、署名済みの証拠（永続ログ）が消えないこと。トレースは
  評価・回帰・影響分析の母体（北極星: 証拠で評価・改善）

**受け入れ基準**

- **[AC-PLAN-007] 耐障害性: 再取込は additive で、署名済み spec を壊さない**
  - Given 既存の計画の木があり、一部の spec は署名済みである
  - When feature を 1 つ追加した roadmap を再取込する
  - Then 追加された feature がちょうど 1 つ計画の木に増え（spawn 可能になる）、既存の署名済み spec とその署名は
    一切変化しない

- **[AC-PLAN-008] 正常系: 鎖が双方向に辿れる（前方参照の固定）**
  - Given spawn かつ署名された feature がある
  - When 計画の木を辿る
  - Then north-star/roadmap → epic → feature → spec → その署名された受け入れ基準、の各リンクが双方向に解決する
    （system 層 data-model が未整備でも、この到達可能性が目標挙動として成り立つ）

- **[AC-PLAN-009] 境界: 計画から外した feature でも署名済み spec を消さない**
  - Given ある feature の spec が署名済みである
  - When その feature を roadmap の源から取り除いて再取込する
  - Then 署名済み spec とその履歴は削除されず、計画から外れた印が付くだけ（削除でなく flag）。著述・署名された
    証拠は計画の都合で破棄しない

**非機能要件**

- 決定論: 同一の roadmap 入力からは同一の計画の木が得られる（再取込で差分が出ない）。
- 可観測性: 取込・spawn・拒否は、進行管理役が状態だけから resume・監査できる形で残る（tmux や人の頭でなく）。

> 上記のうち、分解の質（feature 切り出しの妥当性）は自動採点できない。チャットで人間に指摘し人間が判断する。

**完了条件**

- 自動テスト: 正常（取込・spawn・トレース）／異常（AC 混入拒否・outcome 不在拒否）／耐障害性（冪等 spawn・
  additive 再取込・署名保全）を各 1 以上。
- データ確認: 取込後・spawn 後・再取込後の永続状態（計画の木）が期待どおりであること。

## レッドライン

> 実装が**絶対にしてはならない**こと。Generator への明示的禁止。

- 計画の木のスキーマ（Feature/Epic/Spec の型・ID 形式・store 形）を本 spec.md に埋め込まない（system 層
  data-model を前方参照する）。
- roadmap に受け入れ基準・issue 契約を持たせない（AC は署名された spec にのみ）。
- 再取込・再 spawn で、署名済み spec／著述途中の spec／その署名を上書き・削除しない。
- 計画から外した feature の署名済み spec を物理削除しない（flag に留める）。
- 1 つの spec を 2 つの feature に共有させない（1 Feature = 1 spec を崩さない）。
