# legacy task の grader コマンド backfill（curate の enrichment） 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「コマンド未捕捉（legacy）の回帰 task が、curate の機会に
> 実行可能性を後付け獲得する、その観測可能な性質と非破壊ゲート」。EvalTask の型・捕捉写像
> （検証メソッド→config.target.graders）の細部は FEAT-001（regression-multi-target-execution）と
> `apps/agentops/src/domain/schema.ts`（Zod SSOT・ADR-0002）が既に定義済み — 本機能は**新しい捕捉規則を発明しない**。
>
> **背景（実測の欠け）**: FEAT-001 で curate は新規 task に grader コマンドを捕捉するようになったが、
> curate は task id 冪等（既存 id は触らない）ため、**FEAT-001 以前の既存 6 task は永久に legacy のまま**。
> sandbox 束縛 2 件は「no grader command: none captured at curation … re-curate to capture」で skip され
> 続け（④の regress 実測）、跨 target 実走は registry のどの task でも起きない。
>
> **参照する固定制約**: [NORTH_STAR](../../NORTH_STAR.md)（失敗は必ず回帰評価ケースへ・二度繰り返さない）／
> ADR-0001（store は追記の真実 — 既存記録の破壊禁止）／FEAT-001 の捕捉意味論（コマンドは記録するもの・
> 捏造しないもの）。dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Legacy task grader-command backfill
- outcome（価値・なぜ今）: FEAT-001 以前に捕捉された registry の legacy task（コマンド未捕捉）が、その target を現に採点している curate の機会に実行可能性を後付け獲得する。移行を手作業や re-curate の破壊なしに終わらせ、跨 target 実走を registry 全体へ波及させる。
- 計画の木リンク: feature=FEAT-002 epic=EPIC-01

## REGBF-A curate の enrichment（非破壊の後付け捕捉）

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス・③改善ループ）
- 何を: curate 実行時、現在の config.target と同じ target に束縛されたコマンド未捕捉 task へ、
  config.target.graders から grader コマンドを後付け捕捉する
- なぜ: curate の id 冪等は「重複 task を作らない」ためであって「既存 task を進化させない」ためではない。
  legacy task の実行可能性は、その target を**現に採点している** config が手元にある curate の瞬間にだけ
  正しく埋められる（後からの推測や手作業移行は捏造リスク）。これで FEAT-001 の跨 target 実走が
  registry 全体へ波及する

**受け入れ基準**

- **[AC-REGBF-001] 正常系: 現 target のコマンド未捕捉 task は curate で実行可能性を後付け獲得する**
  - Given コマンド未捕捉（legacy）の task が現在の config.target.repo と同じ target に束縛されており、
    config.target.graders にその task の検証メソッドに対応するコマンドがある
  - When curate を実行する
  - Then その task は FEAT-001 と同じ捕捉写像で grader コマンドを獲得する。task は**複製されず**
    （id 冪等のまま）、id・userGoal・steps・expected・severity・target・createdAt は不変。再度 curate
    しても結果は同じ（enrichment は冪等）

- **[AC-REGBF-002] 耐障害性: 捕捉済みコマンドは決して上書きしない**
  - Given 既に grader コマンドを捕捉済みの task があり、現在の config.target.graders が**別の**コマンドを
    持っている
  - When curate を実行する
  - Then その task の捕捉済みコマンドは変化しない（curation 時点の記録が真実・ADR-0001。config の変遷で
    歴史を書き換えない）

- **[AC-REGBF-003] 異常系: 別 target・未束縛の task は enrichment の対象外**
  - Given コマンド未捕捉の task が、現在の config.target.repo と**異なる** target に束縛されている、
    または target 未束縛（null・legacy）である
  - When curate を実行する
  - Then その task は enrichment されない（この config が採点していない target のコマンドを推測で
    与えない — 捕捉は「現に採点している」事実の記録であって推測ではない）

**非機能要件**

- 決定論: enrichment は決定論・冪等（同一 store×config からは同一結果）。
- 可観測性: enrichment の有無は store の task 状態だけから監査できる。

**完了条件**

- 自動テスト: 正常（後付け捕捉・複製なし・不変フィールド・冪等）／耐障害性（上書きなし）／
  異常（別 target 非対象・未束縛非対象）を各 1 以上。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 既存 task の id・記録済みフィールド（userGoal / steps / expected / severity / target / createdAt /
  捕捉済み graderCommands）を書き換え・削除しない（enrichment は**空欄を埋める**ことだけができる）。
- config に無いコマンドを捏造しない（FEAT-001 のレッドラインを継承）。
- 合格基準（既存テスト）を弱体化しない。
