# 回帰 task の複数 target 実行（束縛の完全化） 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「Curator が捕捉した回帰 task が、config.target の切替に
> 生存して**再検証され続ける**、その観測可能な性質」。EvalTask / RegressionRun の型の細部・実装関数の
> 形は system 層（evaluation コンテキスト）と `apps/agentops/src/domain/schema.ts`
> （Zod SSOT・ADR-0002）が定義する。
>
> **背景（実測の欠け）**: 現行 v0 の回帰実行者は「現在の config.target に束縛された task」しか実走できず、
> 別 target（例: `.harness/sandbox`）で捕捉した失敗は target を切り替えた瞬間から死蔵される
> （regressionExecutedRate 66.7% の頭打ち・handoff §4）。捕捉した失敗が実行されない在庫に退化することは
> 北極星の操舵指標「同じ種類の失敗を二度繰り返さない」の反証サインである。
>
> **参照する固定制約**: [NORTH_STAR](../../NORTH_STAR.md)（失敗は必ず回帰評価ケースへ）／
> ADR-0007（③改善ループの配線）／never-silent（`ARCH-execution-015`: 実行できない検証は理由付きで
> 報告・捏造しない）。dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Regression multi-target execution
- outcome（価値・なぜ今）: 回帰 task が束縛 target とともに実行可能性（grader コマンド）も保持し、config.target がどこを向いていても、ディスク上に在る target の task は再検証され続ける（executedRate の頭打ち解消）。
- 計画の木リンク: feature=FEAT-001 epic=EPIC-01

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| REGMT-A | 束縛の完全化（curate が実行可能性まで捕捉する） | 高 |
| REGMT-B | 複数 target 実行と正直な skip（never-silent） | 高 |

## REGMT-A 束縛の完全化

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・③改善ループ）
- 何を: Curator が回帰 task を作るとき、target repo だけでなく**その task を実走するための grader
  コマンド**まで task 自身に捕捉する
- なぜ: 実行可能性が config の現在値に寄生していると、target を切り替えた瞬間に task が実行不能へ
  退化する。task が自己完結に「どこで・どう走るか」を持てば、捕捉した失敗は config の変遷から独立に
  再検証され続ける（store＝単一の真実・ADR-0001）

**受け入れ基準**

- **[AC-REGMT-001] 正常系: curate は grader コマンドを task に捕捉する**
  - Given config.target が graders（検証メソッド→実行コマンド）を持ち、実走記録のある issue の
    blocker AC が回帰昇格の対象である
  - When curate を実行する
  - Then 作られた回帰 task は、束縛 target に加えて**その AC の検証メソッドに対応する grader
    コマンド**を保持する（後から config.target が別の repo を向いても、この task は自分の実走手段を
    失わない）。コマンドが config に無いメソッドは捕捉されない（無い物を捏造しない）

## REGMT-B 複数 target 実行と正直な skip

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・③改善ループ）
- 何を: 回帰実行者が、束縛 target ごとに task 群をまとめ、実走可能な target を全て再検証する。
  実走できない task は理由付きで skip 報告する
- なぜ: 回帰資産は複数 target（sandbox・self-hosted・将来の実プロダクト）に跨って蓄積される。
  「現在の target の task だけ実走」では資産の大半が常に死蔵される。一方で実走できないものを
  pass 扱いすることは false-pass であり、never-silent（理由付き skip）だけが正直な中間である

**受け入れ基準**

- **[AC-REGMT-002] 正常系: 捕捉済みコマンドを持つ task は config.target と不一致でも実走される**
  - Given ある task が target A に束縛され grader コマンドを捕捉しており、config.target は別の
    repo B を向いているが、A はディスク上に存在する
  - When 回帰実行する
  - Then その task は A に対して捕捉済みコマンドで実走され、結果（pass / fail / unverified）が
    RegressionRun として記録される（skip されない）。同一 target に束縛された複数 task は
    1 回の grader 実走を共有する（task ごとに再実行しない）

- **[AC-REGMT-003] 異常系: 実走の前提を欠く task は理由を特定して skip 報告する**
  - Given ある task の束縛 target repo がディスク上に存在しない、または task がコマンド未捕捉
    （legacy）でかつ config.target とも不一致である
  - When 回帰実行する
  - Then その task は「どの前提が欠けたか」（repo 不在／コマンド不明）を特定する理由付きで skip
    報告され、RegressionRun は捏造されない（never-silent: 沈黙でも捏造でもなく報告）

- **[AC-REGMT-004] 耐障害性: legacy fallback は不変（後方互換）**
  - Given コマンド未捕捉（legacy）の task が、現在の config.target と同じ target に束縛されている
  - When 回帰実行する
  - Then その task は従来どおり config.target.graders のコマンドで実走され、結果が RegressionRun
    として記録される（既存挙動の後退なし）

**非機能要件**

- 決定論: 判定は決定論。実世界 seam（grader 実走）は注入可能（ADR-0004 の pluggable backend 流儀）。
- 可観測性: skip 理由・実走結果は store（RegressionRun / regress 報告）から resume・監査できる。

**完了条件**

- 自動テスト: 正常（コマンド捕捉・跨 target 実走・実走共有）／異常（repo 不在 skip・コマンド不明 skip）／
  耐障害性（legacy fallback 不変）を各 1 以上。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 実走できない task を pass / fail として捏造しない（unverified・skip 報告のみが正直な中間）。
- 既存の RegressionRun / EvalTask の記録を書き換え・削除しない（store は追記の真実・ADR-0001）。
- 合格基準（既存テスト）を弱体化しない。
