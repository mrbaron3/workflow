# 本番配線ピン規約 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「挙動を決める運用定数の inline literal 配線という
> 失敗クラス（⑥ major の一般化: 変異が全テストを素通りする）が、規約・レビュア rubric・
> 既存箇所の棚卸しピンの三層で封じられる」という観測可能な性質。定数の置き場所・命名は
> 実装の裁量。
>
> **背景（grounded 実例）**: ⑥ ISSUE-0007 の残存 major は「liveness cap が inline literal で、
> 10 分へ戻す変異が全テスト生存」だった（人間が REVIEW_LIVENESS / GENERATOR_LIVENESS として
> export しピン化 — 条件付き承認 1 例目）。⑫の棚卸しで同クラスの現存を確認済み:
> `config.panel?.maxConcurrent ?? 4`（config 既定 4 と callsite fallback 4 の**二重符号化** —
> 片方の変異がもう片方に隠れる）・tmux submit の `attempts ?? 4` / `settleMs ?? 1500` 等。
>
> **参照する固定制約**: `ARCH-evaluation-006`（metrics）／`LANG-evaluation-008`（hard gate —
> 変異が素通りするテストは false-pass の構造穴）。dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Production-wiring pin convention
- outcome（価値・なぜ今）: 「テストに素通りされる inline 定数配線」クラス（⑥ major の一般化）が generator 規約と testQuality rubric で封じられ、既存の該当箇所（pollMs / maxConcurrent / panel 閾値等）が棚卸しでピン化される。
- 計画の木リンク: feature=FEAT-006 epic=EPIC-02

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| PIN-A | 規約の三層化（generator 規約・testQuality rubric） | 高 |
| PIN-B | 既存該当箇所の棚卸しピン化 | 高 |

## PIN-A 規約の三層化

**ユーザーストーリー**

- 誰が: 進行管理役・独立レビュア（testQuality）
- 何を: 「運用定数は exported 定数＋ピンテスト」を generator の義務とレビュアの検査項目にする
- なぜ: ⑥⑨⑩⑫の条件付き承認は全て「品質ピン欠如」を人間が持ち込む形だった。書く側の規約と
  見る側の rubric が揃って初めて、このクラスは人間ゲート前に閉じる

**受け入れ基準**

- **[AC-PIN-001] 正常系: generator 役割プロンプトに本番配線ピン規約が義務として載る**
  - Given generator へ発行される役割プロンプト
  - When プロンプトを組み立てる
  - Then 「挙動を決める運用定数（間隔・上限・閾値・天井）は inline literal で配線せず、
    exported 定数にしてその値/性質を pin するテストを添える」趣旨の義務が TDD プロトコルと
    同格の規約として含まれる

- **[AC-PIN-002] 正常系: testQuality レビュアの rubric に検査項目が載る**
  - Given testQuality 観点のレビュアプロンプト（rubric）
  - When プロンプトを組み立てる
  - Then 「本番配線の運用定数が inline literal で、値を壊す変異が suite を生き延びないか」を
    検査する項目が rubric に含まれる

## PIN-B 既存該当箇所の棚卸しピン化

**ユーザーストーリー**

- 誰が: 人間（eval 所有者）・進行管理役
- 何を: 規約制定と同時に、既存コードの該当箇所を同じ形（exported 定数＋ピンテスト）へ直す
- なぜ: 規約が新規コードにしか効かないなら、既存の穴（⑫棚卸しで実在確認済み）は永久に残る。
  ⑥の REVIEW_LIVENESS / GENERATOR_LIVENESS と同型に揃えるのが最小の一貫性

**受け入れ基準**

- **[AC-PIN-003] 正常系: 棚卸しで特定済みの inline 配線が exported 定数＋ピンで固定される**
  - Given ⑫棚卸しの該当箇所 — (a) panel 並行上限の既定が config 既定値と callsite fallback で
    二重符号化されている、(b) tmux submit の retry 回数・settle 間隔が inline literal
  - When 実装を確認する
  - Then 各運用定数は単一の exported 定数（または config 既定の単一ソース）になり、その値/
    性質（有限・下限等）を pin するテストが存在して、値を壊す変異が suite で検出される。
    既定値そのものは変えない（挙動不変の REFACTOR）

**非機能要件**

- 互換性: 既定値・挙動は不変（配線の形だけが変わる）。
- 決定論: ピンテストは実 tmux / 実時間に依存しない。

**完了条件**

- 自動テスト: プロンプト規約 2 箇所の内容 pin／棚卸し箇所の定数 pin 各 1 以上。

## レッドライン

> 実装が絶対にしてはならないこと。

- `test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 既定値を変えない（本 issue は配線形の REFACTOR — 挙動変更は別 WHAT）。
- ⑥の既存ピン（REVIEW_LIVENESS / GENERATOR_LIVENESS とその床値ガード）を弱体化しない。
- 合格基準（既存テスト）を弱体化しない。
